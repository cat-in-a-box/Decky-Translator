# main.py
import asyncio
from asyncio.subprocess import PIPE
import os
import sys
import traceback
import subprocess
import signal
import time
from datetime import datetime
from pathlib import Path
import logging
import json
import base64
import tarfile

# IMPORTANT: Set up plugin directory FIRST
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

# Auto-extract dependencies archive if needed (for Decky Store installs)
# This must happen BEFORE importing third-party libraries
BIN_DIR = os.path.join(PLUGIN_DIR, "bin")
DEPENDENCIES_ARCHIVE = os.path.join(BIN_DIR, "plugin-dependencies.tar.gz")
EXTRACTION_MARKER = os.path.join(BIN_DIR, ".dependencies-extracted")
BIN_PY_MODULES_DIR = os.path.join(BIN_DIR, "py_modules")
BIN_RAPIDOCR_DIR = os.path.join(BIN_DIR, "rapidocr")

def _should_extract_dependencies():
    """Check if dependencies archive needs to be extracted."""
    if not os.path.exists(DEPENDENCIES_ARCHIVE):
        return False  # No dependencies archive to extract

    # Check if extraction marker exists
    if not os.path.exists(EXTRACTION_MARKER):
        return True  # Never extracted successfully

    # Check if dependencies were updated (archive is newer than marker)
    archive_mtime = os.path.getmtime(DEPENDENCIES_ARCHIVE)
    marker_mtime = os.path.getmtime(EXTRACTION_MARKER)
    if archive_mtime > marker_mtime:
        return True  # Dependencies were updated, need to re-extract

    # Check if all expected directories exist (partial extraction detection)
    if not all(os.path.exists(d) for d in [BIN_PY_MODULES_DIR, BIN_RAPIDOCR_DIR]):
        return True  # Some directories missing, need to re-extract

    return False  # Already extracted and up-to-date

if _should_extract_dependencies():
    try:
        print(f"[Decky Translator] Extracting dependencies from {DEPENDENCIES_ARCHIVE}...")
        with tarfile.open(DEPENDENCIES_ARCHIVE, "r:gz") as tar:
            tar.extractall(path=BIN_DIR)
        # Create marker file to indicate successful extraction
        with open(EXTRACTION_MARKER, "w") as f:
            f.write(f"Extracted at {datetime.now().isoformat()}\n")
        print(f"[Decky Translator] Dependencies extracted successfully")
    except Exception as e:
        print(f"[Decky Translator] Failed to extract dependencies: {e}")
        # Remove marker if it exists, so we retry next time
        if os.path.exists(EXTRACTION_MARKER):
            os.remove(EXTRACTION_MARKER)

# Add py_modules to path
# Root py_modules always needed (contains providers/ source code)
# bin/py_modules needed for store installs (pip packages from remote_binary)
ROOT_PY_MODULES_DIR = os.path.join(PLUGIN_DIR, "py_modules")

if ROOT_PY_MODULES_DIR not in sys.path:
    sys.path.insert(0, ROOT_PY_MODULES_DIR)

if os.path.exists(BIN_PY_MODULES_DIR) and BIN_PY_MODULES_DIR not in sys.path:
    sys.path.insert(0, BIN_PY_MODULES_DIR)

# Now import third-party libraries (after sys.path is configured)
import decky_plugin
import urllib3
import requests

# Import provider system
from providers import ProviderManager, TextRegion, NetworkError, ApiKeyError, RateLimitError

_processing_lock = False

# Get environment variable
settingsDir = os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "/home/deck/homebrew/settings")

# Set up logging
logger = decky_plugin.logger

# Make sure we use the right paths
DECKY_PLUGIN_DIR = os.environ.get("DECKY_PLUGIN_DIR", decky_plugin.DECKY_PLUGIN_DIR)
DECKY_PLUGIN_LOG_DIR = os.environ.get("DECKY_PLUGIN_LOG_DIR", decky_plugin.DECKY_PLUGIN_LOG_DIR)
DECKY_HOME = os.environ.get("DECKY_HOME", decky_plugin.DECKY_HOME or "/home/deck")

# Set up paths
DEPSPATH = Path(DECKY_PLUGIN_DIR) / "bin"
if not DEPSPATH.exists():
    DEPSPATH = Path(DECKY_PLUGIN_DIR) / "backend/out"
GSTPLUGINSPATH = DEPSPATH / "gstreamer-1.0"

# Log configured paths for debugging
logger.debug(f"DECKY_PLUGIN_DIR: {DECKY_PLUGIN_DIR}")
logger.debug(f"DECKY_PLUGIN_LOG_DIR: {DECKY_PLUGIN_LOG_DIR}")
logger.debug(f"DECKY_HOME: {DECKY_HOME}")
logger.debug(f"Dependencies path: {DEPSPATH}")
logger.debug(f"GStreamer plugins path: {GSTPLUGINSPATH}")

# Ensure log directory exists
os.makedirs(DECKY_PLUGIN_LOG_DIR, exist_ok=True)

# Set up log files
std_out_file_path = Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator-std-out.log"
std_out_file = open(std_out_file_path, "w")
std_err_file = open(Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator-std-err.log", "w")
logger.debug(f"Standard output logs: {std_out_file_path}")

# Set up file logging
from logging.handlers import TimedRotatingFileHandler

log_file = Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator.log"
log_file_handler = TimedRotatingFileHandler(log_file, when="midnight", backupCount=2)
log_file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logger.handlers.clear()
logger.addHandler(log_file_handler)
logger.setLevel(logging.INFO)
logger.info(f"Configured rotating log file: {log_file}")


import threading
import queue
import fcntl
import struct
import select


class HidrawButtonMonitor:
    """
    Monitors Steam Deck controller via /dev/hidraw for low-level button detection.
    Detects L4, L5, R4, R5, Steam, and QAM buttons that Steam normally intercepts.
    """

    # Device identification
    VALVE_VID = 0x28DE
    STEAMDECK_PID = 0x1205
    PACKET_SIZE = 64
    POLL_INTERVAL = 0.004  # 250Hz - matches controller report rate

    # HID ioctl command
    HIDIOCSFEATURE = lambda self, size: (0xC0000000 | (size << 16) | (ord('H') << 8) | 0x06)

    # HID commands for controller initialization
    ID_CLEAR_DIGITAL_MAPPINGS = 0x81
    ID_SET_SETTINGS_VALUES = 0x87
    SETTING_LEFT_TRACKPAD_MODE = 0x07
    SETTING_RIGHT_TRACKPAD_MODE = 0x08
    TRACKPAD_NONE = 0x07
    SETTING_STEAM_WATCHDOG_ENABLE = 0x2D

    # Button masks - ButtonsL (bytes 8-11, uint32 LE)
    BUTTONS_L = {
        'R2': 0x00000001,
        'L2': 0x00000002,
        'R1': 0x00000004,
        'L1': 0x00000008,
        'Y': 0x00000010,
        'B': 0x00000020,
        'X': 0x00000040,
        'A': 0x00000080,
        'DPAD_UP': 0x00000100,
        'DPAD_RIGHT': 0x00000200,
        'DPAD_LEFT': 0x00000400,
        'DPAD_DOWN': 0x00000800,
        'SELECT': 0x00001000,
        'STEAM': 0x00002000,
        'START': 0x00004000,
        'L5': 0x00008000,
        'R5': 0x00010000,
        'LEFT_PAD_TOUCH': 0x00020000,
        'RIGHT_PAD_TOUCH': 0x00040000,
        'LEFT_PAD_CLICK': 0x00080000,
        'RIGHT_PAD_CLICK': 0x00100000,
        'L3': 0x00400000,
        'R3': 0x04000000,
    }

    # Button masks - ButtonsH (bytes 12-15, uint32 LE)
    BUTTONS_H = {
        'L4': 0x00000200,
        'R4': 0x00000400,
        'QAM': 0x00040000,
    }

    def __init__(self):
        self.device_fd = None
        self.device_path = None
        self.running = False
        self.thread = None
        self.event_queue = queue.Queue(maxsize=100)
        self.current_buttons = set()
        self.last_buttons_l = 0
        self.last_buttons_h = 0
        self.error_count = 0
        self.initialized = False
        self.lock = threading.Lock()
        logger.debug("HidrawButtonMonitor initialized")

    def find_device(self):
        """Find the Steam Deck controller hidraw device.

        The Steam Deck controller exposes 3 hidraw interfaces:
        - Interface 0 (hidraw0): Not the gamepad interface
        - Interface 1 (hidraw1): Not the gamepad interface
        - Interface 2 (hidraw2): The gamepad interface with button data

        We need to find the one that actually provides gamepad data by checking
        which interface is 1.2 in the device path.
        """
        candidates = []

        for i in range(10):
            path = f'/dev/hidraw{i}'
            if os.path.exists(path):
                uevent_path = f'/sys/class/hidraw/hidraw{i}/device/uevent'
                try:
                    with open(uevent_path, 'r') as f:
                        content = f.read().upper()
                        # Check for Valve Steam Deck controller
                        if '28DE' in content and '1205' in content:
                            candidates.append((i, path))
                            logger.debug(f"Found Valve controller candidate at {path}")
                except Exception as e:
                    logger.debug(f"Cannot read uevent for hidraw{i}: {e}")

        if not candidates:
            logger.warning("Steam Deck controller hidraw device not found")
            return None

        # Try to find the correct interface by checking the symlink path
        # The gamepad interface is typically :1.2
        for i, path in candidates:
            try:
                link_target = os.readlink(f'/sys/class/hidraw/hidraw{i}')
                if ':1.2/' in link_target:
                    logger.info(f"Found Steam Deck gamepad interface at {path} (interface 1.2)")
                    return path
            except Exception as e:
                logger.debug(f"Cannot read symlink for hidraw{i}: {e}")

        # Fallback: try each candidate with a blocking read to see which has data
        for i, path in candidates:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                try:
                    # Use select to check if data is available within 100ms
                    readable, _, _ = select.select([fd], [], [], 0.1)
                    if readable:
                        os.read(fd, 64)
                        os.close(fd)
                        logger.info(f"Found Steam Deck controller at {path} (has data)")
                        return path
                    os.close(fd)
                except Exception:
                    os.close(fd)
            except Exception as e:
                logger.debug(f"Cannot open {path}: {e}")

        # Last resort: return the highest numbered candidate (usually the gamepad)
        if candidates:
            path = candidates[-1][1]
            logger.info(f"Using Steam Deck controller at {path} (last candidate)")
            return path

        logger.warning("Steam Deck controller hidraw device not found")
        return None

    def send_feature_report(self, data):
        """Send a HID feature report to the device."""
        if self.device_fd is None:
            return False
        try:
            # Pad to 64 bytes
            buf = bytes(data) + bytes(64 - len(data))
            fcntl.ioctl(self.device_fd, self.HIDIOCSFEATURE(64), buf)
            return True
        except Exception as e:
            logger.error(f"Failed to send feature report: {e}")
            return False

    def initialize_device(self):
        """Open device and send initialization commands to enable full controller mode."""
        if self.device_path is None:
            self.device_path = self.find_device()
            if self.device_path is None:
                return False

        try:
            # Open device with read/write access
            self.device_fd = os.open(self.device_path, os.O_RDWR)
            logger.info(f"Opened {self.device_path} for hidraw monitoring")

            # Send initialization commands to enable full controller mode
            # Command 1: Clear digital mappings (disable lizard mode)
            if not self.send_feature_report([self.ID_CLEAR_DIGITAL_MAPPINGS]):
                logger.warning("Failed to send CLEAR_DIGITAL_MAPPINGS")

            # Command 2: Set settings to disable trackpad emulation
            settings_cmd = [
                self.ID_SET_SETTINGS_VALUES,
                3,  # Number of settings
                self.SETTING_LEFT_TRACKPAD_MODE, self.TRACKPAD_NONE,
                self.SETTING_RIGHT_TRACKPAD_MODE, self.TRACKPAD_NONE,
                self.SETTING_STEAM_WATCHDOG_ENABLE, 0,
            ]
            if not self.send_feature_report(settings_cmd):
                logger.warning("Failed to send SET_SETTINGS_VALUES")

            self.initialized = True
            logger.info("Steam Deck controller initialized for full button access")
            return True

        except Exception as e:
            logger.error(f"Failed to initialize hidraw device: {e}")
            if self.device_fd is not None:
                try:
                    os.close(self.device_fd)
                except:
                    pass
                self.device_fd = None
            return False

    def start(self):
        """Start the background monitoring thread."""
        if self.running:
            logger.warning("HidrawButtonMonitor already running")
            return True

        if not self.initialize_device():
            logger.error("Failed to initialize device, cannot start monitor")
            return False

        self.running = True
        self.thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.thread.start()
        logger.info("HidrawButtonMonitor started")
        return True

    def stop(self):
        self.running = False

        if self.thread is not None:
            self.thread.join(timeout=2.0)
            self.thread = None

        if self.device_fd is not None:
            try:
                os.close(self.device_fd)
            except:
                pass
            self.device_fd = None

        self.initialized = False
        logger.info("HidrawButtonMonitor stopped")

    def _monitor_loop(self):
        """Background thread main loop - reads HID packets and generates events."""
        logger.info("HidrawButtonMonitor loop started")
        reconnect_delay = 2.0
        max_errors = 10

        while self.running:
            try:
                # Check if we need to reconnect
                if not self.initialized or self.device_fd is None:
                    logger.info("Attempting to reconnect to hidraw device")
                    if not self.initialize_device():
                        time.sleep(reconnect_delay)
                        continue

                # Wait for data with select (timeout to allow checking running flag)
                r, _, _ = select.select([self.device_fd], [], [], 0.1)
                if not r:
                    continue

                # Read packet
                data = os.read(self.device_fd, self.PACKET_SIZE)
                if len(data) >= 16:
                    self._process_packet(data)
                    self.error_count = 0

            except OSError as e:
                self.error_count += 1
                logger.warning(f"Hidraw read error ({self.error_count}): {e}")

                if self.error_count >= max_errors:
                    logger.error("Too many errors, closing device for reconnection")
                    self._close_device()
                    time.sleep(reconnect_delay)

            except Exception as e:
                logger.error(f"Unexpected error in hidraw monitor loop: {e}")
                self.error_count += 1
                time.sleep(0.1)

        logger.info("HidrawButtonMonitor loop ended")

    def _close_device(self):
        """Safely close the device for reconnection."""
        if self.device_fd is not None:
            try:
                os.close(self.device_fd)
            except:
                pass
            self.device_fd = None
        self.initialized = False
        self.device_path = None

    def _process_packet(self, data):
        """Parse HID packet and generate button events."""
        # Parse button states from packet
        buttons_l = struct.unpack('<I', data[8:12])[0]
        buttons_h = struct.unpack('<I', data[12:16])[0]

        # Check if button state changed
        if buttons_l == self.last_buttons_l and buttons_h == self.last_buttons_h:
            return

        timestamp = time.time()
        new_buttons = set()

        # Check ButtonsL
        for name, mask in self.BUTTONS_L.items():
            if buttons_l & mask:
                new_buttons.add(name)

        # Check ButtonsH
        for name, mask in self.BUTTONS_H.items():
            if buttons_h & mask:
                new_buttons.add(name)

        # Generate events for changed buttons
        with self.lock:
            # Buttons that were released
            for button in self.current_buttons - new_buttons:
                event = {
                    "button": button,
                    "pressed": False,
                    "timestamp": timestamp
                }
                try:
                    self.event_queue.put_nowait(event)
                except queue.Full:
                    # Queue full, discard oldest
                    try:
                        self.event_queue.get_nowait()
                        self.event_queue.put_nowait(event)
                    except:
                        pass

            # Buttons that were pressed
            for button in new_buttons - self.current_buttons:
                event = {
                    "button": button,
                    "pressed": True,
                    "timestamp": timestamp
                }
                try:
                    self.event_queue.put_nowait(event)
                except queue.Full:
                    try:
                        self.event_queue.get_nowait()
                        self.event_queue.put_nowait(event)
                    except:
                        pass

            self.current_buttons = new_buttons

        self.last_buttons_l = buttons_l
        self.last_buttons_h = buttons_h

    def get_events(self, max_events=10):
        """Get pending button events from the queue."""
        events = []
        with self.lock:
            for _ in range(max_events):
                try:
                    event = self.event_queue.get_nowait()
                    events.append(event)
                except queue.Empty:
                    break
        return events

    def get_button_state(self):
        """Get the current complete button state (all currently pressed buttons)."""
        with self.lock:
            return list(self.current_buttons)

    def get_status(self):
        """Get monitor status for diagnostics."""
        with self.lock:
            return {
                "running": self.running,
                "initialized": self.initialized,
                "device_path": self.device_path,
                "error_count": self.error_count,
                "queue_size": self.event_queue.qsize(),
                "current_buttons": list(self.current_buttons),
                "last_buttons_l": hex(self.last_buttons_l),
                "last_buttons_h": hex(self.last_buttons_h),
            }


for _p in [ROOT_PY_MODULES_DIR, BIN_PY_MODULES_DIR]:
    if os.path.exists(_p):
        if _p in sys.path:
            sys.path.remove(_p)
        sys.path.insert(0, _p)

try:
    import evdev
    EVDEV_AVAILABLE = True
except ImportError as e:
    EVDEV_AVAILABLE = False
    logger.warning(f"evdev import failed: {e}")
except Exception as e:
    EVDEV_AVAILABLE = False
    logger.warning(f"evdev import error ({type(e).__name__}): {e}")


class EvdevGamepadMonitor:
    """
    Monitors external gamepads (Xbox, PlayStation, etc.) via Linux evdev.
    Filters out Valve's built-in controller (handled by HidrawButtonMonitor).
    """

    SCAN_INTERVAL = 5.0      # seconds between device scans
    CACHE_CLEAR_INTERVAL = 60  # seconds before re-checking rejected devices

    BUTTON_MAP = {
        304: 'A',       # BTN_A / BTN_SOUTH
        305: 'B',       # BTN_B / BTN_EAST
        307: 'X',       # BTN_X / BTN_NORTH (note: 306 is BTN_C)
        308: 'Y',       # BTN_Y / BTN_WEST
        310: 'L1',      # BTN_TL
        311: 'R1',      # BTN_TR
        312: 'L2',      # BTN_TL2
        313: 'R2',      # BTN_TR2
        314: 'SELECT',  # BTN_SELECT
        315: 'START',   # BTN_START
        316: 'STEAM',   # BTN_MODE
        317: 'L3',      # BTN_THUMBL
        318: 'R3',      # BTN_THUMBR
    }

    VALVE_VENDOR = 0x28de

    def __init__(self):
        self.running = False
        self.thread = None
        self.devices = {}  # fd -> InputDevice
        self.device_paths = set()  # tracked device paths
        self._rejected_paths = set()  # paths we already checked and dismissed
        self._last_cache_clear = 0
        self.current_buttons = set()
        self.lock = threading.Lock()
        self.last_scan_time = 0
        logger.debug("EvdevGamepadMonitor initialized")

    def _is_gamepad(self, dev):
        """Check if device has gamepad capabilities (EV_KEY + EV_ABS)."""
        try:
            caps = dev.capabilities(verbose=False)
            has_keys = 1 in caps  # EV_KEY
            has_abs = 3 in caps   # EV_ABS
            return has_keys and has_abs
        except Exception:
            return False

    def _scan_devices(self):
        """Find new external gamepads, skip Valve and virtual devices."""
        if not EVDEV_AVAILABLE:
            return

        now = time.time()
        if now - self._last_cache_clear >= self.CACHE_CLEAR_INTERVAL:
            self._rejected_paths.clear()
            self._last_cache_clear = now

        try:
            for path in evdev.list_devices():
                if path in self.device_paths or path in self._rejected_paths:
                    continue

                try:
                    dev = evdev.InputDevice(path)
                except Exception:
                    self._rejected_paths.add(path)
                    continue

                # Skip virtual devices (empty phys)
                if not dev.phys:
                    dev.close()
                    self._rejected_paths.add(path)
                    continue

                # Skip Valve controllers
                if dev.info.vendor == self.VALVE_VENDOR:
                    dev.close()
                    self._rejected_paths.add(path)
                    continue

                if not self._is_gamepad(dev):
                    dev.close()
                    self._rejected_paths.add(path)
                    continue

                with self.lock:
                    self.devices[dev.fd] = dev
                    self.device_paths.add(path)
                logger.info(f"EvdevGamepadMonitor: found gamepad '{dev.name}' at {path}")

        except Exception as e:
            logger.debug(f"EvdevGamepadMonitor: scan error: {e}")

    def start(self):
        if self.running:
            return True
        self.running = True
        self.thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.thread.start()
        logger.info("EvdevGamepadMonitor started")
        return True

    def stop(self):
        self.running = False
        if self.thread is not None:
            self.thread.join(timeout=2.0)
            self.thread = None

        with self.lock:
            for dev in self.devices.values():
                try:
                    dev.close()
                except Exception:
                    pass
            self.devices.clear()
            self.device_paths.clear()
            self._rejected_paths.clear()
            self.current_buttons.clear()

        logger.info("EvdevGamepadMonitor stopped")

    def _monitor_loop(self):
        logger.info("EvdevGamepadMonitor loop started")

        while self.running:
            now = time.time()
            if now - self.last_scan_time >= self.SCAN_INTERVAL:
                self._scan_devices()
                self.last_scan_time = now

            with self.lock:
                if not self.devices:
                    has_devices = False
                else:
                    has_devices = True
                    fds = list(self.devices.keys())

            if not has_devices:
                time.sleep(0.5)
                continue

            try:
                readable, _, _ = select.select(fds, [], [], 0.1)
            except (ValueError, OSError):
                # Bad fd, a device probably disconnected
                self._remove_stale_devices()
                continue

            for fd in readable:
                with self.lock:
                    dev = self.devices.get(fd)
                if dev is None:
                    continue

                try:
                    for event in dev.read():
                        if event.type == 1:  # EV_KEY
                            name = self.BUTTON_MAP.get(event.code)
                            if name is not None:
                                with self.lock:
                                    if event.value == 1:  # pressed
                                        self.current_buttons.add(name)
                                    elif event.value == 0:  # released
                                        self.current_buttons.discard(name)
                except OSError:
                    logger.info(f"EvdevGamepadMonitor: device disconnected (fd={fd})")
                    self._remove_device(fd)
                except Exception as e:
                    logger.debug(f"EvdevGamepadMonitor: read error fd={fd}: {e}")
                    self._remove_device(fd)

        logger.info("EvdevGamepadMonitor loop ended")

    def _remove_device(self, fd):
        with self.lock:
            dev = self.devices.pop(fd, None)
            if dev:
                self.device_paths.discard(dev.path)
                self._rejected_paths.discard(dev.path)
                try:
                    dev.close()
                except Exception:
                    pass

    def _remove_stale_devices(self):
        with self.lock:
            stale = []
            for fd, dev in self.devices.items():
                try:
                    os.fstat(fd)
                except OSError:
                    stale.append(fd)
            for fd in stale:
                dev = self.devices.pop(fd, None)
                if dev:
                    self.device_paths.discard(dev.path)
                    self._rejected_paths.discard(dev.path)
                    logger.info(f"EvdevGamepadMonitor: removed stale device '{dev.name}'")
                    try:
                        dev.close()
                    except Exception:
                        pass

    def get_button_state(self):
        with self.lock:
            return list(self.current_buttons)

    def get_status(self):
        with self.lock:
            device_names = [dev.name for dev in self.devices.values()]
            return {
                "running": self.running,
                "available": EVDEV_AVAILABLE,
                "device_count": len(self.devices),
                "devices": device_names,
                "current_buttons": list(self.current_buttons),
            }


class SettingsManager:
    def __init__(self, name, settings_directory):
        self.settings_path = os.path.join(settings_directory, f"{name}.json")
        self.settings = {}
        logger.debug(f"SettingsManager initialized with path: {self.settings_path}")

    def read(self):
        try:
            if os.path.exists(self.settings_path):
                with open(self.settings_path, 'r') as f:
                    self.settings = json.load(f)
                logger.debug(f"Settings loaded from {self.settings_path}")
            else:
                logger.warning(f"Settings file does not exist: {self.settings_path}")
        except Exception as e:
            logger.error(f"Failed to read settings: {str(e)}")
            logger.error(traceback.format_exc())
            self.settings = {}

    def set_setting(self, key, value):
        try:
            self.settings[key] = value
            os.makedirs(os.path.dirname(self.settings_path), exist_ok=True)
            with open(self.settings_path, 'w') as f:
                json.dump(self.settings, f, indent=4)
            logger.debug(f"Saved setting {key}={value}")
            return True
        except Exception as e:
            logger.error(f"Failed to save setting {key}: {str(e)}")
            logger.error(traceback.format_exc())
            return False

    def get_setting(self, key, default=None):
        value = self.settings.get(key, default)
        logger.debug(f"Getting setting {key}: {value}")
        return value


def get_cmd_output(cmd, log=True):
    if log:
        logger.debug(f"Executing command: {cmd}")

    try:
        output = subprocess.getoutput(cmd).strip()
        logger.debug(f"Command output: {output[:100]}{'...' if len(output) > 100 else ''}")
        return output
    except Exception as e:
        logger.error(f"Command execution failed: {str(e)}")
        logger.error(traceback.format_exc())
        return f"Error: {str(e)}"


def get_all_children(pid: int) -> list[str]:
    pids = []
    tmpPids = [str(pid)]
    try:
        while tmpPids:
            ppid = tmpPids.pop(0)
            cmd = ["ps", "--ppid", ppid, "-o", "pid="]
            with subprocess.Popen(cmd, stdout=subprocess.PIPE) as p:
                lines = p.stdout.readlines()

            for chldPid in lines:
                if isinstance(chldPid, bytes):
                    chldPid = chldPid.decode('utf-8')
                chldPid = chldPid.strip()
                if not chldPid:
                    continue
                pids.append(chldPid)
                tmpPids.append(chldPid)

        return pids
    except Exception as e:
        logger.error(f"Error finding child processes for pid {pid}: {e}")
        return pids


def get_base64_image(image_path):
    try:
        if not os.path.exists(image_path):
            logger.error(f"Image file does not exist: {image_path}")
            return ""

        file_size = os.path.getsize(image_path)
        if file_size > 10 * 1024 * 1024:
            logger.warning(f"Image file is very large ({file_size} bytes)")

        with open(image_path, "rb") as image_file:
            content = image_file.read()
            return base64.b64encode(content).decode('utf-8')
    except MemoryError:
        logger.error("Memory error encoding image, trying 1MB chunk")
        with open(image_path, "rb") as image_file:
            content = image_file.read(1024 * 1024)
            return base64.b64encode(content).decode('utf-8')
    except Exception as e:
        logger.error(f"Failed to convert image to base64: {e}")
        return ""


class Plugin:
    _filepath: str = None
    _screenshotPath: str = "/tmp/decky-translator"  # Temporary directory for screenshots (deleted after OCR)
    _settings = None
    _input_language: str = "auto"  # Default to auto-detect
    _target_language: str = "en"
    _input_mode: int = 0  # 0 = both touchpads, 1 = left touchpad, 2 = right touchpad
    _hold_time_translate: int = 1000  # Default to 1 second
    _hold_time_dismiss: int = 500  # Default to 0.5 seconds for dismissal
    _confidence_threshold: float = 0.6  # Default confidence threshold
    _rapidocr_confidence: float = 0.5  # RapidOCR-specific confidence threshold (0.0-1.0)
    _rapidocr_box_thresh: float = 0.5  # RapidOCR detection box threshold (0.0-1.0)
    _rapidocr_unclip_ratio: float = 1.6  # RapidOCR box expansion ratio (1.0-3.0)
    _pause_game_on_overlay: bool = False  # Default to not pausing game on overlay
    _quick_toggle_enabled: bool = False  # Default to disabled for quick toggle

    # Hidraw button monitor
    _hidraw_monitor: HidrawButtonMonitor = None
    _evdev_monitor: EvdevGamepadMonitor = None

    # Provider system
    _provider_manager: ProviderManager = None
    _use_free_providers: bool = True  # Default to free providers (no API key needed)
    _ocr_provider: str = "rapidocr"  # "rapidocr" (RapidOCR), "ocrspace" (OCR.space), or "googlecloud" (Google Cloud)
    _translation_provider: str = "freegoogle"  # "freegoogle" or "googlecloud"

    # OCR API configurations - user must provide their own API key
    _google_vision_api_key: str = ""
    _google_translate_api_key: str = ""

    # Generic settings handlers
    async def get_setting(self, key, default=None):
        return self._settings.get_setting(key, default)

    async def set_setting(self, key, value):
        logger.debug(f"Setting {key} to: {value}")
        try:
            if key == "target_language":
                self._target_language = value
            elif key == "input_language":
                self._input_language = value
            elif key == "input_mode":
                self._input_mode = value
            elif key == "enabled":
                # No need to set an instance variable for this
                pass
            elif key == "google_api_key":
                # Single API key for both Vision and Translate
                self._google_vision_api_key = value
                self._google_translate_api_key = value
                # Update provider manager with new API key
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=value,
                        ocr_provider=self._ocr_provider,
                        translation_provider=self._translation_provider
                    )
            elif key == "google_vision_api_key":
                self._google_vision_api_key = value
                # Update provider manager with new API key
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=value,
                        ocr_provider=self._ocr_provider,
                        translation_provider=self._translation_provider
                    )
            elif key == "google_translate_api_key":
                self._google_translate_api_key = value
            elif key == "hold_time_translate":
                self._hold_time_translate = value
            elif key == "hold_time_dismiss":
                self._hold_time_dismiss = value
            elif key == "confidence_threshold":
                self._confidence_threshold = value
            elif key == "rapidocr_confidence":
                self._rapidocr_confidence = value
                # Update provider manager with new confidence
                if self._provider_manager:
                    self._provider_manager.set_rapidocr_confidence(value)
            elif key == "rapidocr_box_thresh":
                self._rapidocr_box_thresh = value
                if self._provider_manager:
                    self._provider_manager.set_rapidocr_box_thresh(value)
            elif key == "rapidocr_unclip_ratio":
                self._rapidocr_unclip_ratio = value
                if self._provider_manager:
                    self._provider_manager.set_rapidocr_unclip_ratio(value)
            elif key == "pause_game_on_overlay":
                self._pause_game_on_overlay = value
            elif key == "quick_toggle_enabled":
                self._quick_toggle_enabled = value
            elif key == "font_scale":
                pass  # frontend-only, just persist to settings file
            elif key == "grouping_power":
                pass  # frontend-only, just persist to settings file
            elif key == "hide_identical_translations":
                pass  # frontend-only, just persist to settings file
            elif key == "allow_label_growth":
                pass  # frontend-only, just persist to settings file
            elif key == "translated_text_alignment":
                pass  # frontend-only, just persist to settings file
            elif key == "translated_text_font_family":
                pass  # frontend-only, just persist to settings file
            elif key == "translated_text_font_style":
                pass  # frontend-only, just persist to settings file
            elif key == "custom_recognition_settings":
                pass  # frontend-only, just persist to settings file
            elif key == "debug_mode":
                logger.setLevel(logging.DEBUG if value else logging.INFO)
            elif key == "use_free_providers":
                self._use_free_providers = value
                # Update provider manager configuration (backwards compatibility)
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=value,
                        google_api_key=self._google_vision_api_key,
                        ocr_provider=self._ocr_provider,
                        translation_provider=self._translation_provider
                    )
            elif key == "ocr_provider":
                self._ocr_provider = value
                # Derive use_free_providers for backwards compatibility
                self._use_free_providers = (value != "googlecloud")
                # Update provider manager configuration
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=self._google_vision_api_key,
                        ocr_provider=value,
                        translation_provider=self._translation_provider
                    )
            elif key == "translation_provider":
                self._translation_provider = value
                # Update provider manager configuration
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=self._google_vision_api_key,
                        ocr_provider=self._ocr_provider,
                        translation_provider=value
                    )
            else:
                logger.warning(f"Unknown setting key: {key}")

            return self._settings.set_setting(key, value)
        except Exception as e:
            logger.error(f"Error setting {key}: {str(e)}")
            logger.error(traceback.format_exc())
            return False

    async def get_all_settings(self):
        try:
            settings = {
                "target_language": self._target_language,
                "input_language": self._input_language,
                "input_mode": self._input_mode,
                "enabled": self._settings.get_setting("enabled", True),
                "use_free_providers": self._use_free_providers,
                "ocr_provider": self._ocr_provider,
                "translation_provider": self._translation_provider,
                "google_api_key": self._google_vision_api_key,  # Single key for frontend
                "google_vision_api_key": self._google_vision_api_key,
                "google_translate_api_key": self._google_translate_api_key,
                "hold_time_translate": self._settings.get_setting("hold_time_translate", 1000),
                "hold_time_dismiss": self._settings.get_setting("hold_time_dismiss", 500),
                "confidence_threshold": self._settings.get_setting("confidence_threshold", 0.6),
                "rapidocr_confidence": self._settings.get_setting("rapidocr_confidence", 0.5),
                "rapidocr_box_thresh": self._settings.get_setting("rapidocr_box_thresh", 0.5),
                "rapidocr_unclip_ratio": self._settings.get_setting("rapidocr_unclip_ratio", 1.6),
                "pause_game_on_overlay": self._settings.get_setting("pause_game_on_overlay", False),
                "quick_toggle_enabled": self._settings.get_setting("quick_toggle_enabled", False),
                "debug_mode": self._settings.get_setting("debug_mode", False),
                "font_scale": self._settings.get_setting("font_scale", 1.0),
                "grouping_power": self._settings.get_setting("grouping_power", 0.25),
                "translated_text_alignment": self._settings.get_setting("translated_text_alignment", "justify"),
                "translated_text_font_family": self._settings.get_setting("translated_text_font_family", ""),
                "translated_text_font_style": self._settings.get_setting("translated_text_font_style", "normal"),
                "hide_identical_translations": self._settings.get_setting("hide_identical_translations", False),
                "allow_label_growth": self._settings.get_setting("allow_label_growth", False),
                "custom_recognition_settings": self._settings.get_setting("custom_recognition_settings", False)
            }
            return settings
        except Exception as e:
            logger.error(f"Error getting all settings: {str(e)}")
            logger.error(traceback.format_exc())
            return {}

    async def get_provider_status(self):
        try:
            if self._provider_manager:
                return self._provider_manager.get_provider_status()
            return {"error": "Provider manager not initialized"}
        except Exception as e:
            logger.error(f"Error getting provider status: {str(e)}")
            return {"error": str(e)}

    async def take_screenshot(self, app_name: str = ""):
        logger.debug(f"Taking screenshot for app: {app_name}")
        global _processing_lock

        if _processing_lock:
            logger.info("Screenshot already in progress, skipping")
            raise RuntimeError("Screenshot already in progress")

        # Minimal test‑pattern in case encoding fails or file isn't created
        test_base64 = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+"
            "FABJADveWyWxwAAAAAElFTkSuQmCC"
        )

        try:
            _processing_lock = True

            # Sanitize and default app name
            if not app_name or app_name.strip().lower() == "null":
                app_name = "Decky-Screenshot"
            else:
                app_name = app_name.replace(":", " ").replace("/", " ").strip()

            # Build filename
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            os.makedirs(self._screenshotPath, exist_ok=True)
            screenshot_path = f"{self._screenshotPath}/{app_name}_{timestamp}.png"
            logger.debug(f"Screenshot path: {screenshot_path}")

            # Prepare environment
            env = os.environ.copy()
            env.update({
                "XDG_RUNTIME_DIR": "/run/user/1000",
                "XDG_SESSION_TYPE": "wayland",
                "HOME": DECKY_HOME
            })

            # GStreamer pipeline: grab a few frames then EOS
            # Using num-buffers=5 to skip potentially invalid first frames from PipeWire
            cmd = (
                # keep only the path to your plugins, without GST_VAAPI_ALL_DRIVERS
                f"GST_PLUGIN_PATH={GSTPLUGINSPATH} "
                f"LD_LIBRARY_PATH={DEPSPATH} "
                f"gst-launch-1.0 -e "
                # capture multiple buffers to ensure valid frame (pngenc snapshot=true saves last)
                f"pipewiresrc do-timestamp=true num-buffers=5 ! "
                # let videoconvert work by default (CPU), it will create normal raw
                f"videoconvert ! "
                # then directly to PNG
                f"pngenc snapshot=true ! "
                f"filesink location=\"{screenshot_path}\""
            )
            logger.debug(f"GStreamer command: {cmd}")

            # Launch subprocess asynchronously
            proc = await asyncio.create_subprocess_exec(
                'gst-launch-1.0',
                '-e',
                'pipewiresrc',
                'do-timestamp=true',
                'num-buffers=5',
                '!',
                'videoconvert',
                '!',
                'pngenc',
                'snapshot=true',
                '!',
                'filesink',
                f'location={screenshot_path}',
                stdout=PIPE,
                stderr=PIPE,
                env=env
            )
            # Wait for pipeline to finish (it will exit after 1 frame), with timeout
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout=5)
            except asyncio.TimeoutError:
                logger.warning("GStreamer timed out after 5s, sending SIGINT for graceful shutdown")
                proc.send_signal(signal.SIGINT)
                try:
                    # give 2 more seconds to finish after SIGINT
                    out, err = await asyncio.wait_for(proc.communicate(), timeout=2)
                except asyncio.TimeoutError:
                    logger.error("GStreamer did not exit within 2s after SIGINT, killing process")
                    proc.kill()
                    out, err = await proc.communicate()

            logger.debug(f"GStreamer stdout: {out.decode().strip() or 'None'}")
            stderr_output = err.decode().strip()
            if stderr_output:
                logger.debug(f"GStreamer stderr: {stderr_output}")
            logger.debug(f"GStreamer return code: {proc.returncode}")

            # Give the filesystem a moment - seems to work without it
            # await asyncio.sleep(0.25)

            # Check file and return
            if os.path.exists(screenshot_path) and os.path.getsize(screenshot_path) > 0:
                size = os.path.getsize(screenshot_path)
                logger.debug(f"Screenshot saved ({size} bytes)")
                base64_data = get_base64_image(screenshot_path)
                if base64_data:
                    return {"path": screenshot_path, "base64": base64_data}
                else:
                    logger.error("Failed to encode screenshot to base64 — returning test pattern")
                    return {"path": screenshot_path, "base64": test_base64}
            else:
                logger.error(f"Screenshot file missing or empty: {screenshot_path}")
                return {"path": "", "base64": test_base64}

        except Exception as e:
            logger.error(f"Screenshot error: {e}")
            logger.error(traceback.format_exc())
            return {"path": "", "base64": test_base64}

        finally:
            _processing_lock = False

    async def saveConfig(self):
        try:
            if not self._settings:
                logger.error("Cannot save config - settings not initialized")
                return False

            results = [
                self._settings.set_setting("target_language", self._target_language),
                self._settings.set_setting("google_api_key", self._google_vision_api_key),
                self._settings.set_setting("input_mode", self._input_mode),
                self._settings.set_setting("input_language", self._input_language),
                self._settings.set_setting("hold_time_translate", self._hold_time_translate),
                self._settings.set_setting("hold_time_dismiss", self._hold_time_dismiss),
                self._settings.set_setting("confidence_threshold", self._confidence_threshold),
                self._settings.set_setting("pause_game_on_overlay", self._pause_game_on_overlay),
                self._settings.set_setting("quick_toggle_enabled", self._quick_toggle_enabled),
            ]
            return all(results)
        except Exception as e:
            logger.error(f"Error saving config: {e}")
            logger.error(traceback.format_exc())
            return False

    async def is_paused(self, pid: int) -> bool:
        try:
            cmd = ["ps", "--pid", str(pid), "-o", "stat="]
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                stdout, stderr = p.communicate()
                status = stdout.lstrip().decode('utf-8')
                return status.startswith('T')
        except Exception as e:
            logger.error(f"is_paused: Error checking pause status: {e}")
            logger.error(traceback.format_exc())
            return False

    async def pause(self, pid: int) -> bool:
        logger.debug(f"Pausing process {pid}")
        if not pid:
            return False

        pids = get_all_children(pid)
        if pids:
            pids.insert(0, str(pid))
            command = ["kill", "-SIGSTOP"]
            command.extend(pids)
            try:
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                return result.returncode == 0
            except Exception as e:
                logger.error(f"Error pausing process {pid}: {e}")
                return False
        else:
            try:
                command = ["kill", "-SIGSTOP", str(pid)]
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                return result.returncode == 0
            except Exception as e:
                logger.error(f"Error pausing process {pid}: {e}")
                return False

    async def resume(self, pid: int) -> bool:
        logger.debug(f"Resuming process {pid}")
        if not pid:
            return False

        pids = get_all_children(pid)
        if pids:
            pids.insert(0, str(pid))
            command = ["kill", "-SIGCONT"]
            command.extend(pids)
            try:
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                return result.returncode == 0
            except Exception as e:
                logger.error(f"Error resuming process {pid}: {e}")
                return False
        else:
            try:
                command = ["kill", "-SIGCONT", str(pid)]
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                return result.returncode == 0
            except Exception as e:
                logger.error(f"Error resuming process {pid}: {e}")
                return False

    async def terminate(self, pid: int) -> bool:
        pids = get_all_children(pid)
        if pids:
            command = ["kill", "-SIGTERM"]
            command.extend(pids)
            try:
                return subprocess.run(command, stderr=sys.stderr, stdout=sys.stdout).returncode == 0
            except:
                return False
        else:
            return False

    async def kill(self, pid: int) -> bool:
        pids = get_all_children(pid)
        if pids:
            command = ["kill", "-SIGKILL"]
            command.extend(pids)
            try:
                return subprocess.run(command, stderr=sys.stderr, stdout=sys.stdout).returncode == 0
            except:
                return False
        else:
            return False

    async def pid_from_appid(self, appid: int) -> int:
        pid = ""
        try:
            cmd = ["pgrep", "--full", "--oldest", f"/reaper\\s.*\\bAppId={appid}\\b"]
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                stdout, stderr = p.communicate()
                pid = stdout.strip()

            if not pid:
                cmd = ["pgrep", "-f", f"GameId={appid}"]
                with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                    stdout, stderr = p.communicate()
                    pid = stdout.strip()

            if pid:
                return int(pid)
            else:
                logger.debug(f"No process found for AppId={appid}")
                return 0
        except Exception as e:
            logger.error(f"Error finding pid for AppId={appid}: {e}")
            return 0

    async def appid_from_pid(self, pid: int) -> int:
        logger.debug(f"Looking for AppId with pid={pid}")
        while pid and pid != 1:
            try:
                with open(f"/proc/{pid}/cmdline", "r") as f:
                    args = f.read().split('\0')

                for arg in args:
                    arg = arg.strip()
                    if arg.startswith("AppId="):
                        arg = arg.lstrip("AppId=")
                        if arg:
                            logger.debug(f"Found AppId={arg} for pid={pid}")
                            return int(arg)
            except Exception:
                pass

            try:
                cmd = ["ps", "--pid", str(pid), "-o", "ppid="]
                with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                    stdout, _ = p.communicate()
                    strppid = stdout.strip()

                if strppid:
                    pid = int(strppid)
                else:
                    break
            except Exception as e:
                logger.error(f"Error finding parent for pid={pid}: {e}")
                break

        logger.debug(f"No AppId found for pid={pid}")
        return 0

    def _sample_bg_colors(self, image_bytes, text_regions):
        """Sample average background color for each OCR region from the screenshot."""
        try:
            from PIL import Image
            import io
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            img_width, img_height = img.size
            pixels = img.load()

            for region in text_regions:
                r = region.rect
                left = max(0, r.get("left", 0))
                top = max(0, r.get("top", 0))
                right = min(img_width, r.get("right", 0))
                bottom = min(img_height, r.get("bottom", 0))

                if right <= left or bottom <= top:
                    continue

                w = right - left
                h = bottom - top
                step_x = max(1, w // 5)
                step_y = max(1, h // 5)

                total_r, total_g, total_b = 0, 0, 0
                count = 0
                for sy in range(top, bottom, step_y):
                    for sx in range(left, right, step_x):
                        pr, pg, pb = pixels[sx, sy]
                        total_r += pr
                        total_g += pg
                        total_b += pb
                        count += 1

                if count > 0:
                    region.bg_color = [
                        total_r // count,
                        total_g // count,
                        total_b // count
                    ]
        except Exception as e:
            logger.debug(f"Background color sampling failed (non-fatal): {e}")

    async def recognize_text(self, image_data: str):
        try:
            if not image_data:
                logger.error("Empty image data for text recognition")
                return []

            if image_data.startswith('data:image'):
                image_data = image_data.split(',', 1)[1]

            image_bytes = base64.b64decode(image_data)

            if not self._provider_manager:
                logger.error("Provider manager not initialized")
                return []

            start_time = time.time()
            text_regions = await self._provider_manager.recognize_text(
                image_bytes,
                language=self._input_language
            )
            logger.info(f"OCR completed in {time.time() - start_time:.2f}s, found {len(text_regions)} regions")

            # Disabled temporarily
            # TODO: Work on it
            # self._sample_bg_colors(image_bytes, text_regions)

            return [region.to_dict() for region in text_regions]

        except NetworkError as e:
            logger.error(f"Network error during OCR: {e}")
            return {"error": "network_error", "message": str(e)}
        except ApiKeyError as e:
            logger.error(f"API key error during OCR: {e}")
            return {"error": "api_key_error", "message": "Invalid API key"}
        except RateLimitError as e:
            logger.error(f"Rate limit during OCR: {e}")
            return {"error": "rate_limit_error", "message": str(e)}
        except Exception as e:
            logger.error(f"Text recognition error: {e}")
            logger.error(traceback.format_exc())
            return []

    async def recognize_text_file(self, image_path: str):
        try:
            if not os.path.exists(image_path):
                logger.error(f"Image file does not exist: {image_path}")
                return []

            base64_data = get_base64_image(image_path)
            if not base64_data:
                logger.error("Failed to encode image for OCR")
                return []

            return await Plugin.recognize_text(self, base64_data)
        except Exception as e:
            logger.error(f"recognize_text_file error: {e}")
            logger.error(traceback.format_exc())
            return []
        finally:
            if image_path and os.path.exists(image_path):
                try:
                    os.remove(image_path)
                    logger.debug(f"Deleted temporary screenshot: {image_path}")
                except Exception as cleanup_error:
                    logger.warning(f"Failed to delete temporary screenshot: {cleanup_error}")

    async def translate_text(self, text_regions, target_language=None, input_language=None):
        try:
            if not text_regions:
                return []

            target_lang = target_language or self._target_language
            input_lang = input_language or self._input_language

            if not self._provider_manager:
                logger.error("Provider manager not initialized")
                return None

            texts_to_translate = [region["text"] for region in text_regions]

            start_time = time.time()
            translated_texts = await self._provider_manager.translate_text(
                texts_to_translate,
                source_lang=input_lang,
                target_lang=target_lang
            )
            logger.info(f"Translation completed in {time.time() - start_time:.2f}s, {len(texts_to_translate)} regions")

            translated_regions = []
            for i, translated_text in enumerate(translated_texts):
                if i < len(text_regions):
                    translated_regions.append({
                        **text_regions[i],
                        "translatedText": translated_text
                    })

            return translated_regions

        except NetworkError as e:
            logger.error(f"Network error during translation: {e}")
            return {"error": "network_error", "message": str(e)}
        except ApiKeyError as e:
            logger.error(f"API key error during translation: {e}")
            return {"error": "api_key_error", "message": "Invalid API key"}
        except Exception as e:
            logger.error(f"Translation error: {e}")
            logger.error(traceback.format_exc())
            return None

    async def get_enabled_state(self):
        return await self.get_setting("enabled", True)

    async def set_enabled_state(self, enabled):
        return await self.set_setting("enabled", enabled)

    async def get_input_language(self):
        return self._input_language

    async def set_input_language(self, language):
        return await self.set_setting("input_language", language)

    async def get_confidence_threshold(self):
        return self._confidence_threshold

    async def set_confidence_threshold(self, threshold: float):
        return await self.set_setting("confidence_threshold", threshold)

    async def get_pause_game_on_overlay(self):
        return self._pause_game_on_overlay

    async def set_pause_game_on_overlay(self, enabled: bool):
        self._pause_game_on_overlay = enabled
        return await self.set_setting("pause_game_on_overlay", enabled)

    async def get_target_language(self):
        return self._target_language

    async def set_target_language(self, language):
        return await self.set_setting("target_language", language)

    async def get_input_mode(self):
        return self._input_mode

    async def set_input_mode(self, mode):
        return await self.set_setting("input_mode", mode)

    async def start_hidraw_monitor(self):
        try:
            if self._hidraw_monitor is None:
                self._hidraw_monitor = HidrawButtonMonitor()

            if self._hidraw_monitor.running:
                hidraw_ok = True
            elif self._hidraw_monitor.start():
                hidraw_ok = True
            else:
                hidraw_ok = False

            # Start evdev monitor for external gamepads
            if EVDEV_AVAILABLE:
                if self._evdev_monitor is None:
                    self._evdev_monitor = EvdevGamepadMonitor()
                if not self._evdev_monitor.running:
                    self._evdev_monitor.start()

            if hidraw_ok:
                return {"success": True, "message": "Monitor started"}
            else:
                return {"success": False, "error": "Failed to initialize device"}
        except Exception as e:
            logger.error(f"Error starting hidraw monitor: {e}")
            return {"success": False, "error": str(e)}

    async def stop_hidraw_monitor(self):
        try:
            if self._hidraw_monitor:
                self._hidraw_monitor.stop()
            if self._evdev_monitor:
                self._evdev_monitor.stop()
            return {"success": True, "message": "Monitor stopped"}
        except Exception as e:
            logger.error(f"Error stopping hidraw monitor: {e}")
            return {"success": False, "error": str(e)}

    async def get_hidraw_events(self, max_events: int = 10):
        """Get pending button events from the hidraw monitor."""
        try:
            if self._hidraw_monitor and self._hidraw_monitor.running:
                events = self._hidraw_monitor.get_events(max_events)
                return {"success": True, "events": events}
            return {"success": False, "events": [], "error": "Monitor not running"}
        except Exception as e:
            logger.error(f"Error getting hidraw events: {e}")
            return {"success": False, "events": [], "error": str(e)}

    async def get_hidraw_button_state(self):
        """Get the current complete button state from both monitors.

        Merges button state from hidraw (built-in controller) and evdev
        (external gamepads) via set union.
        """
        try:
            buttons = set()
            any_running = False

            if self._hidraw_monitor and self._hidraw_monitor.running:
                any_running = True
                buttons.update(self._hidraw_monitor.get_button_state())

            if self._evdev_monitor and self._evdev_monitor.running:
                any_running = True
                buttons.update(self._evdev_monitor.get_button_state())

            if any_running:
                return {"success": True, "buttons": list(buttons)}
            return {"success": False, "buttons": [], "error": "Monitor not running"}
        except Exception as e:
            logger.error(f"Error getting hidraw button state: {e}")
            return {"success": False, "buttons": [], "error": str(e)}

    async def get_hidraw_status(self):
        """Get hidraw and evdev monitor status for diagnostics."""
        try:
            status = {}
            if self._hidraw_monitor:
                status["hidraw"] = self._hidraw_monitor.get_status()
            else:
                status["hidraw"] = {"running": False, "initialized": False}

            if self._evdev_monitor:
                status["evdev"] = self._evdev_monitor.get_status()
            else:
                status["evdev"] = {"running": False, "available": EVDEV_AVAILABLE}

            return {"success": True, "status": status}
        except Exception as e:
            logger.error(f"Error getting hidraw status: {e}")
            return {"success": False, "error": str(e)}

    async def _main(self):
        logger.info("Plugin initialization started")
        try:
            self._settings = SettingsManager(
                name="decky-translator-settings",
                settings_directory=settingsDir
            )
            self._settings.read()

            def load_setting(key, default):
                saved = self._settings.get_setting(key)
                if saved is not None:
                    return saved
                self._settings.set_setting(key, default)
                return default

            # Load basic settings
            self._target_language = load_setting("target_language", self._target_language)
            self._input_language = load_setting("input_language", self._input_language)
            self._input_mode = load_setting("input_mode", self._input_mode)
            self._hold_time_translate = load_setting("hold_time_translate", self._hold_time_translate)
            self._hold_time_dismiss = load_setting("hold_time_dismiss", self._hold_time_dismiss)
            if self._settings.get_setting("custom_recognition_settings", False):
                self._confidence_threshold = load_setting("confidence_threshold", self._confidence_threshold)
            self._pause_game_on_overlay = load_setting("pause_game_on_overlay", self._pause_game_on_overlay)
            self._quick_toggle_enabled = load_setting("quick_toggle_enabled", self._quick_toggle_enabled)

            os.makedirs(self._screenshotPath, exist_ok=True)

            google_api_key = self._settings.get_setting("google_api_key", "")
            if google_api_key:
                self._google_vision_api_key = google_api_key
                self._google_translate_api_key = google_api_key

            saved_ocr_provider = self._settings.get_setting("ocr_provider")
            if saved_ocr_provider is not None:
                self._ocr_provider = saved_ocr_provider
                self._use_free_providers = (saved_ocr_provider != "googlecloud")
            else:
                self._settings.set_setting("ocr_provider", self._ocr_provider)

            # Load translation provider
            saved_translation_provider = self._settings.get_setting("translation_provider")
            if saved_translation_provider is not None:
                self._translation_provider = saved_translation_provider
            else:
                if self._ocr_provider == "googlecloud":
                    self._translation_provider = "googlecloud"
                else:
                    self._translation_provider = "freegoogle"
                self._settings.set_setting("translation_provider", self._translation_provider)

            # Initialize provider manager
            self._provider_manager = ProviderManager()
            self._provider_manager.configure(
                use_free_providers=self._use_free_providers,
                google_api_key=google_api_key,
                ocr_provider=self._ocr_provider,
                translation_provider=self._translation_provider
            )

            # Load and apply RapidOCR-specific settings
            if self._settings.get_setting("custom_recognition_settings", False):
                self._rapidocr_confidence = load_setting("rapidocr_confidence", self._rapidocr_confidence)
                self._rapidocr_box_thresh = load_setting("rapidocr_box_thresh", self._rapidocr_box_thresh)
                self._rapidocr_unclip_ratio = load_setting("rapidocr_unclip_ratio", self._rapidocr_unclip_ratio)
            self._provider_manager.set_rapidocr_confidence(self._rapidocr_confidence)
            self._provider_manager.set_rapidocr_box_thresh(self._rapidocr_box_thresh)
            self._provider_manager.set_rapidocr_unclip_ratio(self._rapidocr_unclip_ratio)

            # Apply debug_mode log level
            if self._settings.get_setting("debug_mode", False):
                logger.setLevel(logging.DEBUG)
                logger.debug("Debug logging enabled")

            provider_status = self._provider_manager.get_provider_status()
            logger.info(f"Initialized - OCR: {provider_status.get('ocr_provider', '?')}, "
                        f"Translation: {provider_status.get('translation_provider', '?')}, "
                        f"Target lang: {self._target_language}")

            # Start hidraw button monitor
            self._hidraw_monitor = HidrawButtonMonitor()
            if self._hidraw_monitor.start():
                logger.info("Hidraw button monitor started")
            else:
                logger.warning("Failed to start hidraw button monitor")

            # Start evdev monitor for external gamepads
            if EVDEV_AVAILABLE:
                self._evdev_monitor = EvdevGamepadMonitor()
                if self._evdev_monitor.start():
                    logger.info("Evdev gamepad monitor started")
                else:
                    logger.warning("Failed to start evdev gamepad monitor")
            else:
                logger.info("evdev not available, external gamepad support disabled")

        except Exception as e:
            logger.error(f"Error during initialization: {e}")
            logger.error(traceback.format_exc())
        return

    async def _unload(self):
        logger.info("Unloading plugin")
        try:
            if self._evdev_monitor:
                self._evdev_monitor.stop()
                self._evdev_monitor = None

            if self._hidraw_monitor:
                self._hidraw_monitor.stop()
                self._hidraw_monitor = None

            std_out_file.close()
            std_err_file.close()
        except Exception as e:
            logger.error(f"Error during plugin unload: {e}")
            logger.error(traceback.format_exc())
        return