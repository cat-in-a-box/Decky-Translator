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
import re
import json
import base64
import tarfile
import shutil
import glob
from urllib.parse import urlparse, unquote

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
BIN_PYTHON_DIR = os.path.join(BIN_DIR, "python313")

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
    if not all(os.path.isdir(d) for d in [BIN_PY_MODULES_DIR, BIN_PYTHON_DIR]):
        return True  # Some directories missing, need to re-extract

    return False  # Already extracted and up-to-date

if _should_extract_dependencies():
    try:
        print(f"[Decky Language Tutor] Extracting dependencies from {DEPENDENCIES_ARCHIVE}...")
        with tarfile.open(DEPENDENCIES_ARCHIVE, "r:gz") as tar:
            tar.extractall(path=BIN_DIR)
        # Create marker file to indicate successful extraction
        with open(EXTRACTION_MARKER, "w") as f:
            f.write(f"Extracted at {datetime.now().isoformat()}\n")
        print(f"[Decky Language Tutor] Dependencies extracted successfully")
    except Exception as e:
        print(f"[Decky Language Tutor] Failed to extract dependencies: {e}")
        # Remove marker if it exists, so we retry next time
        if os.path.exists(EXTRACTION_MARKER):
            os.remove(EXTRACTION_MARKER)

# rapidocr 3 checks this dir exists at init time
_RAPIDOCR_MODELS_PLACEHOLDER = os.path.join(BIN_PY_MODULES_DIR, "rapidocr", "models")
if os.path.isdir(os.path.dirname(_RAPIDOCR_MODELS_PLACEHOLDER)):
    os.makedirs(_RAPIDOCR_MODELS_PLACEHOLDER, exist_ok=True)

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
from providers.translation_cache import TranslationCache, PROVIDER_TIERS, normalize

_processing_lock = False

SENSITIVE_SETTING_KEYS = {
    "google_api_key",
    "google_vision_api_key",
    "google_translate_api_key",
    "gemini_api_key",
}


def _mask_secret(value):
    if not isinstance(value, str) or not value:
        return value
    if len(value) <= 4:
        return "****"
    return "*" * (len(value) - 4) + value[-4:]


def _mask_for_log(key, value):
    return _mask_secret(value) if key in SENSITIVE_SETTING_KEYS else value


_API_KEY_JUNK_RE = re.compile(r"[\s\u200b\u200c\u200d\u2060\ufeff]+")


def _clean_api_key(value):
    if not isinstance(value, str):
        return value
    return _API_KEY_JUNK_RE.sub("", value)


_URL_KEY_RE = re.compile(r"\bkey=([A-Za-z0-9_\-]{16,})")


def _redact_url_keys(text):
    return _URL_KEY_RE.sub(lambda m: f"key={_mask_secret(m.group(1))}", text)


class UrlKeyRedactFilter(logging.Filter):
    def filter(self, record):
        try:
            if isinstance(record.msg, str) and "key=" in record.msg:
                record.msg = _redact_url_keys(record.msg)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {
                        k: _redact_url_keys(v) if isinstance(v, str) and "key=" in v else v
                        for k, v in record.args.items()
                    }
                else:
                    record.args = tuple(
                        _redact_url_keys(a) if isinstance(a, str) and "key=" in a else a
                        for a in record.args
                    )
        except Exception:
            pass
        return True


_url_redact_filter = UrlKeyRedactFilter()


# Get environment variable
settingsDir = os.path.join(
    os.environ.get("DECKY_PLUGIN_SETTINGS_DIR", "/home/deck/homebrew/settings"),
    "decky-language-tutor",
)

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
std_out_file_path = Path(DECKY_PLUGIN_LOG_DIR) / "decky-language-tutor-std-out.log"
std_out_file = open(std_out_file_path, "w")
std_err_file = open(Path(DECKY_PLUGIN_LOG_DIR) / "decky-language-tutor-std-err.log", "w")
logger.debug(f"Standard output logs: {std_out_file_path}")

# Set up file logging
from logging.handlers import TimedRotatingFileHandler

log_file = Path(DECKY_PLUGIN_LOG_DIR) / "decky-language-tutor.log"
log_file_handler = TimedRotatingFileHandler(log_file, when="midnight", backupCount=2)
log_file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
log_file_handler.addFilter(_url_redact_filter)
logger.handlers.clear()
logger.addHandler(log_file_handler)
logger.setLevel(logging.INFO)
logging.getLogger("urllib3").addFilter(_url_redact_filter)
logger.info(f"Configured rotating log file: {log_file}")

try:
    with open(os.path.join(PLUGIN_DIR, "package.json")) as _pkg:
        _plugin_version = json.load(_pkg).get("version", "unknown")
except Exception as _e:
    _plugin_version = "unknown"
logger.info(f"Decky Language Tutor v{_plugin_version} starting")


import threading
import queue
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
    # InputPlumber virtual controller (used on non-Steam Deck handhelds like Legion Go)
    INPUTPLUMBER_PID = 0x12FB
    PACKET_SIZE = 64
    POLL_INTERVAL = 0.004  # 250Hz - matches controller report rate

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
        'LEFT_PAD_TOUCH': 0x00080000,
        'RIGHT_PAD_TOUCH': 0x00100000,
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
        self.device_pid = None  # Track which product we connected to
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
        """Find a Valve-compatible controller hidraw device.

        Supports:
        - Steam Deck controller (VID:28DE, PID:1205) with 3 hidraw interfaces
        - InputPlumber virtual controller (VID:28DE, PID:12FB) on non-Steam Deck handhelds

        For Steam Deck, we need interface :1.2 for gamepad data.
        For InputPlumber, there's typically a single virtual hidraw device.
        """
        steamdeck_candidates = []
        other_valve_candidates = []

        for i in range(10):
            path = f'/dev/hidraw{i}'
            if os.path.exists(path):
                uevent_path = f'/sys/class/hidraw/hidraw{i}/device/uevent'
                try:
                    with open(uevent_path, 'r') as f:
                        content = f.read().upper()
                        if '28DE' not in content:
                            continue
                        if '1205' in content:
                            steamdeck_candidates.append((i, path))
                            logger.debug(f"Found Steam Deck controller candidate at {path}")
                        elif '12FB' in content:
                            other_valve_candidates.append((i, path))
                            logger.debug(f"Found InputPlumber virtual controller candidate at {path}")
                        else:
                            # Valve devices use non-standard HID protocols - let evdev handle them
                            logger.debug(f"Skipping unsupported Valve hidraw at {path}")
                except Exception as e:
                    logger.debug(f"Cannot read uevent for hidraw{i}: {e}")

        # Prefer real Steam Deck controller (interface :1.2)
        if steamdeck_candidates:
            for i, path in steamdeck_candidates:
                try:
                    link_target = os.readlink(f'/sys/class/hidraw/hidraw{i}')
                    if ':1.2/' in link_target:
                        logger.info(f"Found Steam Deck gamepad interface at {path} (interface 1.2)")
                        self.device_pid = self.STEAMDECK_PID
                        return path
                except Exception as e:
                    logger.debug(f"Cannot read symlink for hidraw{i}: {e}")

            # Fallback: try data availability
            for i, path in steamdeck_candidates:
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                    try:
                        readable, _, _ = select.select([fd], [], [], 0.1)
                        if readable:
                            os.read(fd, 64)
                            os.close(fd)
                            logger.info(f"Found Steam Deck controller at {path} (has data)")
                            self.device_pid = self.STEAMDECK_PID
                            return path
                        os.close(fd)
                    except Exception:
                        os.close(fd)
                except Exception as e:
                    logger.debug(f"Cannot open {path}: {e}")

            # Last resort for Steam Deck
            path = steamdeck_candidates[-1][1]
            logger.info(f"Using Steam Deck controller at {path} (last candidate)")
            self.device_pid = self.STEAMDECK_PID
            return path

        # Try InputPlumber / other Valve virtual devices
        if other_valve_candidates:
            for i, path in other_valve_candidates:
                try:
                    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                    try:
                        readable, _, _ = select.select([fd], [], [], 0.1)
                        if readable:
                            os.read(fd, 64)
                            os.close(fd)
                            logger.info(f"Found Valve-compatible controller at {path} (has data)")
                            self.device_pid = self.INPUTPLUMBER_PID
                            return path
                        os.close(fd)
                    except Exception:
                        os.close(fd)
                except Exception as e:
                    logger.debug(f"Cannot open {path}: {e}")

            # Last resort
            path = other_valve_candidates[-1][1]
            logger.info(f"Using Valve-compatible controller at {path} (last candidate)")
            self.device_pid = self.INPUTPLUMBER_PID
            return path

        logger.info("No supported Valve hidraw device found; relying on evdev only")
        return None

    def initialize_device(self):
        """Read controller reports without changing Steam Input mappings."""
        if self.device_path is None:
            self.device_path = self.find_device()
            if self.device_path is None:
                return False

        try:
            self.device_fd = os.open(self.device_path, os.O_RDONLY)
            logger.info(f"Opened {self.device_path} for read-only hidraw monitoring")

            self.initialized = True
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
        self.device_pid = None

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


class TritonHidrawMonitor:
    VALVE_VID = 0x28DE
    PROTEUS_PID = 0x1304
    NEREID_PID = 0x1305
    REPORT_ID_INPUT = 0x42
    PACKET_SIZE = 64

    BUTTONS = {
        0x00000020: 'R3',
        0x00000080: 'R4',
        0x00000100: 'R5',
        0x00008000: 'L3',
        0x00020000: 'L4',
        0x00040000: 'L5',
        0x00200000: 'RIGHT_PAD_TOUCH',
        0x02000000: 'LEFT_PAD_TOUCH',
    }

    def __init__(self):
        self.device_fds = []
        self.device_paths = []
        self.running = False
        self.thread = None
        self.event_queue = queue.Queue(maxsize=100)
        self.current_buttons = set()
        self.last_buttons = 0
        self.error_count = 0
        self.initialized = False
        self.lock = threading.Lock()
        logger.debug("TritonHidrawMonitor initialized")

    def find_devices(self):
        found = []
        for i in range(16):
            path = f'/dev/hidraw{i}'
            if not os.path.exists(path):
                continue
            try:
                with open(f'/sys/class/hidraw/hidraw{i}/device/uevent') as f:
                    content = f.read().upper()
                if '28DE' not in content:
                    continue
                if '1304' in content or '1305' in content:
                    found.append(path)
                    logger.debug(f"Found Triton hidraw candidate at {path}")
            except Exception as e:
                logger.debug(f"Cannot read uevent for hidraw{i}: {e}")
        return found

    def initialize_device(self):
        self.device_paths = self.find_devices()
        if not self.device_paths:
            return False
        for path in self.device_paths:
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
                self.device_fds.append(fd)
                logger.info(f"Opened {path} for Triton hidraw monitoring (read-only)")
            except Exception as e:
                logger.debug(f"Could not open {path}: {e}")
        if not self.device_fds:
            self.device_paths = []
            return False
        self.initialized = True
        return True

    def start(self):
        if self.running:
            return True
        if not self.initialize_device():
            logger.info("No Triton dongle present; TritonHidrawMonitor not started")
            return False
        self.running = True
        self.thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self.thread.start()
        logger.info("TritonHidrawMonitor started")
        return True

    def stop(self):
        self.running = False
        if self.thread is not None:
            self.thread.join(timeout=2.0)
            self.thread = None
        self._close_devices()
        self.initialized = False
        logger.info("TritonHidrawMonitor stopped")

    def _close_devices(self):
        for fd in self.device_fds:
            try:
                os.close(fd)
            except Exception:
                pass
        self.device_fds = []
        self.device_paths = []

    def _monitor_loop(self):
        logger.info("TritonHidrawMonitor loop started")
        reconnect_delay = 2.0
        max_errors = 10

        while self.running:
            try:
                if not self.initialized or not self.device_fds:
                    if not self.initialize_device():
                        time.sleep(reconnect_delay)
                        continue

                r, _, _ = select.select(self.device_fds, [], [], 0.1)
                if not r:
                    continue

                for fd in r:
                    try:
                        data = os.read(fd, self.PACKET_SIZE)
                    except OSError as e:
                        self.error_count += 1
                        logger.warning(f"Triton hidraw read error ({self.error_count}): {e}")
                        if self.error_count >= max_errors:
                            logger.error("Too many Triton read errors, reconnecting")
                            self._close_devices()
                            self.initialized = False
                            time.sleep(reconnect_delay)
                        break

                    if len(data) >= 6 and data[0] == self.REPORT_ID_INPUT:
                        self._process_packet(data)
                        self.error_count = 0

            except Exception as e:
                logger.error(f"Unexpected error in Triton monitor loop: {e}")
                self.error_count += 1
                time.sleep(0.1)

        logger.info("TritonHidrawMonitor loop ended")

    def _process_packet(self, data):
        buttons = struct.unpack('<I', data[2:6])[0]
        if buttons == self.last_buttons:
            return

        timestamp = time.time()
        new_buttons = set()
        for mask, name in self.BUTTONS.items():
            if buttons & mask:
                new_buttons.add(name)

        with self.lock:
            for button in self.current_buttons - new_buttons:
                event = {"button": button, "pressed": False, "timestamp": timestamp}
                try:
                    self.event_queue.put_nowait(event)
                except queue.Full:
                    try:
                        self.event_queue.get_nowait()
                        self.event_queue.put_nowait(event)
                    except Exception:
                        pass
            for button in new_buttons - self.current_buttons:
                event = {"button": button, "pressed": True, "timestamp": timestamp}
                try:
                    self.event_queue.put_nowait(event)
                except queue.Full:
                    try:
                        self.event_queue.get_nowait()
                        self.event_queue.put_nowait(event)
                    except Exception:
                        pass
            self.current_buttons = new_buttons

        self.last_buttons = buttons

    def get_events(self, max_events=10):
        events = []
        with self.lock:
            for _ in range(max_events):
                try:
                    events.append(self.event_queue.get_nowait())
                except queue.Empty:
                    break
        return events

    def get_button_state(self):
        with self.lock:
            return list(self.current_buttons)

    def get_status(self):
        with self.lock:
            return {
                "running": self.running,
                "initialized": self.initialized,
                "device_paths": list(self.device_paths),
                "error_count": self.error_count,
                "queue_size": self.event_queue.qsize(),
                "current_buttons": list(self.current_buttons),
                "last_buttons": hex(self.last_buttons),
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
        try:
            caps = dev.capabilities(verbose=False)
            keys = set(caps.get(evdev.ecodes.EV_KEY, []))
            return bool(keys & {
                evdev.ecodes.BTN_SOUTH,
                evdev.ecodes.BTN_EAST,
                evdev.ecodes.BTN_NORTH,
                evdev.ecodes.BTN_WEST,
            })
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

    def set_setting(self, key, value):
        try:
            # re-read so manual edits to the file are not overwritten by stale memory
            self.read()
            self.settings[key] = value
            os.makedirs(os.path.dirname(self.settings_path), exist_ok=True)
            with open(self.settings_path, 'w') as f:
                json.dump(self.settings, f, indent=4)
            logger.debug(f"Saved setting {key}={_mask_for_log(key, value)}")
            return True
        except Exception as e:
            logger.error(f"Failed to save setting {key}: {str(e)}")
            logger.error(traceback.format_exc())
            return False

    def get_setting(self, key, default=None):
        value = self.settings.get(key, default)
        logger.debug(f"Getting setting {key}: {_mask_for_log(key, value)}")
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
    _screenshotPath: str = "/tmp/decky-language-tutor"  # Temporary directory for screenshots (deleted after OCR)
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
    _rapidocr_persistent_mode: bool = False  # Keep RapidOCR worker alive between requests
    _chromescreenai_persistent_mode: bool = False  # Keep Chrome Screen AI worker alive between requests
    _ct2_persistent_mode: bool = False  # Keep CT2/NLLB worker alive between requests
    _pause_game_on_overlay: bool = False  # Default to not pausing game on overlay
    _quick_toggle_enabled: bool = False  # Default to disabled for quick toggle

    # Hidraw button monitor
    _hidraw_monitor: HidrawButtonMonitor = None
    _evdev_monitor: EvdevGamepadMonitor = None
    _triton_monitor: TritonHidrawMonitor = None

    # Provider system
    _provider_manager: ProviderManager = None
    _use_free_providers: bool = True  # Default to free providers (no API key needed)
    _ocr_provider: str = "chromescreenai"  # "rapidocr" (RapidOCR), "ocrspace" (OCR.space), or "googlecloud" (Google Cloud)
    _translation_provider: str = "freegoogle"  # "freegoogle" or "googlecloud"

    # Translation cache
    _translation_cache: TranslationCache = None
    _translation_cache_enabled: bool = True

    # OCR API configurations - user must provide their own API key
    _google_vision_api_key: str = ""
    _google_translate_api_key: str = ""
    _gemini_api_key: str = ""
    _gemini_model: str = "gemini-2.5-flash"

    _has_pngenc = None
    _fallback_dims = None
    _capture_backend = None  # "pipewire" | "spectacle" | "portal" | None
    _session_env = None  # session env (XDG_CURRENT_DESKTOP, DBUS, WAYLAND...)

    def _load_session_env(self):
        # plugin_loader.service starts at boot with no graphical env
        uid = os.getuid()
        desktop_comms = {'plasmashell', 'kwin_wayland', 'kwin_x11', 'gnome-shell', 'sway', 'Hyprland'}
        for proc_path in glob.glob('/proc/[0-9]*'):
            try:
                if os.stat(proc_path).st_uid != uid:
                    continue
                with open(os.path.join(proc_path, 'comm')) as f:
                    if f.read().strip() not in desktop_comms:
                        continue
                with open(os.path.join(proc_path, 'environ'), 'rb') as f:
                    data = f.read()
            except (OSError, PermissionError):
                continue
            result = {}
            for entry in data.split(b'\0'):
                if not entry:
                    continue
                k, _, v = entry.decode(errors='ignore').partition('=')
                if k:
                    result[k] = v
            return result
        return {}

    def _clean_system_binary_env(self, env):
        clean = dict(env)
        for k in ("LD_LIBRARY_PATH", "LD_PRELOAD", "PYTHONHOME", "PYTHONPATH", "_MEIPASS", "_MEIPASS2"):
            clean.pop(k, None)
        orig = env.get("LD_LIBRARY_PATH_ORIG")
        if orig:
            clean["LD_LIBRARY_PATH"] = orig
        return clean

    async def _select_capture_backend(self, env):
        has_video_source = False
        try:
            proc = await asyncio.create_subprocess_exec(
                '/usr/bin/pw-dump', stdout=PIPE, stderr=PIPE, env=env
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            nodes = json.loads(out)
            for n in nodes:
                props = (n.get('info') or {}).get('props') or {}
                if props.get('media.class') == 'Video/Source':
                    has_video_source = True
                    break
        except Exception as e:
            logger.warning(f"pw-dump backend probe failed: {e}")

        if has_video_source:
            backend = "pipewire"
        elif "KDE" in env.get("XDG_CURRENT_DESKTOP", "") and os.path.exists("/usr/bin/spectacle"):
            backend = "spectacle"
        elif os.path.exists("/usr/bin/gdbus"):
            backend = "portal"
        else:
            backend = None

        logger.info(f"Capture backend: {backend}")
        return backend

    async def _probe_fallback_dims(self, env):
        try:
            proc = await asyncio.create_subprocess_exec(
                '/usr/bin/pw-dump', stdout=PIPE, stderr=PIPE, env=env
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            nodes = json.loads(out)
            gamescope_dims = None
            first_dims = None
            for n in nodes:
                info = n.get('info') or {}
                props = info.get('props') or {}
                if props.get('media.class') != 'Video/Source':
                    continue
                for fmt in (info.get('params') or {}).get('EnumFormat', []):
                    sz = fmt.get('size') or {}
                    w, h = sz.get('width'), sz.get('height')
                    if not (w and h):
                        continue
                    if props.get('node.name') == 'gamescope':
                        gamescope_dims = (w, h)
                    if first_dims is None:
                        first_dims = (w, h)
                    break
            return gamescope_dims or first_dims
        except Exception as e:
            logger.warning(f"pw-dump dimension probe failed: {e}")
            return None

    # Generic settings handlers
    async def get_setting(self, key, default=None):
        return self._settings.get_setting(key, default)

    async def set_setting(self, key, value):
        logger.debug(f"Setting {key} to: {_mask_for_log(key, value)}")
        if key in SENSITIVE_SETTING_KEYS and isinstance(value, str):
            cleaned = _clean_api_key(value)
            if cleaned != value:
                logger.warning(
                    f"{key} contained whitespace or invisible characters, "
                    f"cleaned (len {len(value)} -> {len(cleaned)})"
                )
            value = cleaned
            logger.info(f"{key} set (len={len(value)})")
        try:
            if key == "target_language":
                self._target_language = value
            elif key == "input_language":
                self._input_language = value
            elif key == "input_mode":
                self._input_mode = value
            elif key in ("learn_mode", "shortcut_enabled"):
                value = bool(value)
            elif key == "enabled":
                if self._provider_manager:
                    if value:
                        if self._rapidocr_persistent_mode:
                            self._provider_manager.resume_rapidocr_worker()
                        if self._chromescreenai_persistent_mode:
                            self._provider_manager.resume_chromescreenai_worker()
                        if self._ct2_persistent_mode:
                            self._provider_manager.resume_ct2_worker()
                    else:
                        self._provider_manager.stop_rapidocr_worker()
                        self._provider_manager.stop_chromescreenai_worker()
                        self._provider_manager.stop_ct2_worker()
            elif key == "google_api_key":
                # Single API key for both Vision and Translate
                self._google_vision_api_key = value
                self._google_translate_api_key = value
                # Update provider manager with new API key
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=value,
                        gemini_api_key=self._gemini_api_key,
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
                        gemini_api_key=self._gemini_api_key,
                        ocr_provider=self._ocr_provider,
                        translation_provider=self._translation_provider
                    )
            elif key == "google_translate_api_key":
                self._google_translate_api_key = value
            elif key == "gemini_model":
                self._gemini_model = value
                if self._provider_manager:
                    self._provider_manager.set_gemini_model(value)
            elif key == "gemini_api_key":
                self._gemini_api_key = value
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=self._google_vision_api_key,
                        gemini_api_key=value,
                        ocr_provider=self._ocr_provider,
                        translation_provider=self._translation_provider
                    )
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
            elif key == "rapidocr_persistent_mode":
                self._rapidocr_persistent_mode = bool(value)
                if self._provider_manager:
                    plugin_enabled = self._settings.get_setting("enabled", True)
                    self._provider_manager.set_rapidocr_persistent_mode(
                        self._rapidocr_persistent_mode,
                        apply_to_provider=plugin_enabled,
                    )
                    if not plugin_enabled and not self._rapidocr_persistent_mode:
                        self._provider_manager.stop_rapidocr_worker()
            elif key == "chromescreenai_persistent_mode":
                self._chromescreenai_persistent_mode = bool(value)
                if self._provider_manager:
                    plugin_enabled = self._settings.get_setting("enabled", True)
                    self._provider_manager.set_chromescreenai_persistent_mode(
                        self._chromescreenai_persistent_mode,
                        apply_to_provider=plugin_enabled,
                    )
                    if not plugin_enabled and not self._chromescreenai_persistent_mode:
                        self._provider_manager.stop_chromescreenai_worker()
            elif key == "ct2_persistent_mode":
                self._ct2_persistent_mode = bool(value)
                if self._provider_manager:
                    plugin_enabled = self._settings.get_setting("enabled", True)
                    self._provider_manager.set_ct2_persistent_mode(
                        self._ct2_persistent_mode,
                        apply_to_provider=plugin_enabled,
                    )
                    if not plugin_enabled and not self._ct2_persistent_mode:
                        self._provider_manager.stop_ct2_worker()
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
                        gemini_api_key=self._gemini_api_key,
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
                        gemini_api_key=self._gemini_api_key,
                        ocr_provider=value,
                        translation_provider=self._translation_provider
                    )
                    # Don't leave the RapidOCR worker running when the user
                    # switches providers; resume it if they switch back.
                    plugin_enabled = self._settings.get_setting("enabled", True)
                    if value != "rapidocr":
                        self._provider_manager.stop_rapidocr_worker()
                    elif plugin_enabled:
                        self._provider_manager.resume_rapidocr_worker()
                    if value != "chromescreenai":
                        self._provider_manager.stop_chromescreenai_worker()
                    elif plugin_enabled:
                        self._provider_manager.resume_chromescreenai_worker()
            elif key == "translation_provider":
                self._translation_provider = value
                # Update provider manager configuration
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=self._google_vision_api_key,
                        gemini_api_key=self._gemini_api_key,
                        ocr_provider=self._ocr_provider,
                        translation_provider=value
                    )
                    plugin_enabled = self._settings.get_setting("enabled", True)
                    if value != "ct2":
                        self._provider_manager.stop_ct2_worker()
                    elif plugin_enabled:
                        self._provider_manager.resume_ct2_worker()
            elif key == "translation_cache_enabled":
                self._translation_cache_enabled = bool(value)
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
                "learn_mode": self._settings.get_setting("learn_mode", False),
                "shortcut_enabled": self._settings.get_setting("shortcut_enabled", False),
                "use_free_providers": self._use_free_providers,
                "ocr_provider": self._ocr_provider,
                "translation_provider": self._translation_provider,
                "google_api_key": self._google_vision_api_key,  # Single key for frontend
                "google_vision_api_key": self._google_vision_api_key,
                "google_translate_api_key": self._google_translate_api_key,
                "gemini_api_key": self._gemini_api_key,
                "gemini_model": self._gemini_model,
                "hold_time_translate": self._settings.get_setting("hold_time_translate", 1000),
                "hold_time_dismiss": self._settings.get_setting("hold_time_dismiss", 500),
                "confidence_threshold": self._settings.get_setting("confidence_threshold", 0.6),
                "rapidocr_confidence": self._settings.get_setting("rapidocr_confidence", 0.5),
                "rapidocr_box_thresh": self._settings.get_setting("rapidocr_box_thresh", 0.5),
                "rapidocr_unclip_ratio": self._settings.get_setting("rapidocr_unclip_ratio", 1.6),
                "rapidocr_persistent_mode": self._settings.get_setting("rapidocr_persistent_mode", False),
                "chromescreenai_persistent_mode": self._settings.get_setting("chromescreenai_persistent_mode", False),
                "ct2_persistent_mode": self._settings.get_setting("ct2_persistent_mode", False),
                "pause_game_on_overlay": self._settings.get_setting("pause_game_on_overlay", False),
                "quick_toggle_enabled": self._settings.get_setting("quick_toggle_enabled", False),
                "debug_mode": self._settings.get_setting("debug_mode", False),
                "font_scale": self._settings.get_setting("font_scale", 1.0),
                "grouping_power": self._settings.get_setting("grouping_power", 0.25),
                "translated_text_alignment": self._settings.get_setting("translated_text_alignment", "center"),
                "translated_text_font_family": self._settings.get_setting("translated_text_font_family", ""),
                "translated_text_font_style": self._settings.get_setting("translated_text_font_style", "normal"),
                "hide_identical_translations": self._settings.get_setting("hide_identical_translations", False),
                "allow_label_growth": self._settings.get_setting("allow_label_growth", False),
                "custom_recognition_settings": self._settings.get_setting("custom_recognition_settings", False),
                "translation_cache_enabled": self._translation_cache_enabled,
            }
            return settings
        except Exception as e:
            logger.error(f"Error getting all settings: {str(e)}")
            logger.error(traceback.format_exc())
            return {}

    async def get_gemini_models(self):
        try:
            if not self._gemini_api_key:
                return []
            gemini = self._provider_manager.get_ocr_provider() if (
                self._provider_manager and self._ocr_provider == "gemini_vision"
            ) else None
            if not gemini:
                from providers.gemini_vision import GeminiVisionProvider
                gemini = GeminiVisionProvider(api_key=self._gemini_api_key)
            import asyncio
            return await asyncio.to_thread(gemini.list_available_models)
        except Exception as e:
            logger.error(f"Error fetching Gemini models: {e}")
            return []

    async def get_provider_status(self):
        try:
            if self._provider_manager:
                return self._provider_manager.get_provider_status()
            return {"error": "Provider manager not initialized"}
        except Exception as e:
            logger.error(f"Error getting provider status: {str(e)}")
            return {"error": str(e)}

    async def check_web_reachability(self):
        try:
            if self._provider_manager:
                return await self._provider_manager.check_web_reachability()
            return {"error": "Provider manager not initialized"}
        except Exception as e:
            logger.error(f"Error checking web reachability: {str(e)}")
            return {"error": str(e)}

    async def take_screenshot(self, app_name: str = ""):
        logger.debug(f"Taking screenshot for app: {app_name}")
        global _processing_lock

        if _processing_lock:
            logger.info("Screenshot already in progress, skipping")
            raise RuntimeError("Screenshot already in progress")

        # Real captures run 100KB+, tiny PNGs are videoconvert corruption or missing frames
        MIN_VALID_SIZE = 30_000
        MAX_ATTEMPTS = 3

        FALLBACK_NUM_BUFFERS = 1
        FALLBACK_STDDEV_THRESHOLD = 10

        try:
            _processing_lock = True

            # Sanitize and default app name
            if not app_name or app_name.strip().lower() == "null":
                app_name = "Decky-Screenshot"
            else:
                app_name = app_name.replace(":", " ").replace("/", " ").strip()

            # Build filename
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S_%f")
            os.makedirs(self._screenshotPath, exist_ok=True)
            screenshot_path = f"{self._screenshotPath}/{app_name}_{timestamp}.png"
            logger.debug(f"Screenshot path: {screenshot_path}")

            uid = os.getuid()
            xdg_runtime = f"/run/user/{uid}"

            result = {"path": "", "base64": ""}
            for _ in range(2):
                if self._capture_backend is None or self._session_env is None:
                    self._session_env = self._load_session_env()
                    logger.info(f"Session env borrowed: XDG_CURRENT_DESKTOP={self._session_env.get('XDG_CURRENT_DESKTOP', '<unset>')}")

                env = os.environ.copy()
                for k, v in self._session_env.items():
                    env.setdefault(k, v)
                env.setdefault("XDG_RUNTIME_DIR", xdg_runtime)
                env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={xdg_runtime}/bus")
                env.setdefault("WAYLAND_DISPLAY", "wayland-0")
                env.setdefault("HOME", DECKY_HOME)

                if self._capture_backend is None:
                    self._capture_backend = await self._select_capture_backend(env)

                if self._capture_backend == "pipewire":
                    result = await self._take_screenshot_pipewire(
                        env, screenshot_path,
                        MIN_VALID_SIZE, MAX_ATTEMPTS, FALLBACK_NUM_BUFFERS, FALLBACK_STDDEV_THRESHOLD,
                    )
                elif self._capture_backend == "spectacle":
                    result = await self._take_screenshot_spectacle(env, screenshot_path, MIN_VALID_SIZE)
                elif self._capture_backend == "portal":
                    result = await self._take_screenshot_portal(env, screenshot_path, MIN_VALID_SIZE)
                else:
                    logger.error("No capture backend available for this session")
                    return result

                if result["path"] or self._capture_backend is not None:
                    return result

            return result

        except Exception as e:
            logger.error(f"Screenshot error: {e}")
            logger.error(traceback.format_exc())
            return {"path": "", "base64": ""}

        finally:
            _processing_lock = False

    async def _take_screenshot_pipewire(self, env, screenshot_path, MIN_VALID_SIZE, MAX_ATTEMPTS, FALLBACK_NUM_BUFFERS, FALLBACK_STDDEV_THRESHOLD):
        env = dict(env)
        env.update({
            "XDG_SESSION_TYPE": "wayland",
            "GST_PLUGIN_PATH": str(GSTPLUGINSPATH),
            "LD_LIBRARY_PATH": str(DEPSPATH),
        })

        # Pngenc probing
        if self._has_pngenc is None:
            try:
                probe = await asyncio.create_subprocess_exec(
                    '/usr/bin/gst-inspect-1.0', '--exists', 'pngenc',
                    stdout=PIPE, stderr=PIPE
                )
                await asyncio.wait_for(probe.communicate(), timeout=2.0)
                self._has_pngenc = (probe.returncode == 0)
            except Exception as e:
                logger.warning(f"pngenc probe failed ({e}); using Pillow fallback")
                self._has_pngenc = False
            logger.info(f"GStreamer pngenc available: {self._has_pngenc}")

        if not self._has_pngenc:
            if self._fallback_dims is None:
                self._fallback_dims = await self._probe_fallback_dims(env)
                logger.info(f"Fallback capture dims: {self._fallback_dims}")
            if self._fallback_dims is None:
                logger.error("Cannot run Pillow fallback: pw-dump did not return a Video/Source resolution")
                return {"path": "", "base64": ""}

        if self._has_pngenc:
            cmd = (
                f"GST_PLUGIN_PATH={GSTPLUGINSPATH} "
                f"LD_LIBRARY_PATH={DEPSPATH} "
                f"gst-launch-1.0 -e "
                f"pipewiresrc do-timestamp=true num-buffers=5 ! "
                f"videoconvert ! "
                f"pngenc snapshot=true ! "
                f"filesink location=\"{screenshot_path}\""
            )
        else:
            cmd = (
                f"GST_PLUGIN_PATH={GSTPLUGINSPATH} "
                f"LD_LIBRARY_PATH={DEPSPATH} "
                f"gst-launch-1.0 -q -e "
                f"pipewiresrc do-timestamp=true num-buffers={FALLBACK_NUM_BUFFERS} ! "
                f"videoconvert ! video/x-raw,format=RGB ! "
                f"fdsink fd=1"
            )
        logger.debug(f"GStreamer command: {cmd}")

        for attempt in range(1, MAX_ATTEMPTS + 1):
            if attempt > 1:
                await asyncio.sleep(0.3)
                logger.info(f"Retrying screenshot capture (attempt {attempt}/{MAX_ATTEMPTS})")

            if self._has_pngenc and os.path.exists(screenshot_path):
                try:
                    os.remove(screenshot_path)
                except OSError as e:
                    logger.warning(f"Could not remove stale screenshot file: {e}")

            if self._has_pngenc:
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
            else:
                proc = await asyncio.create_subprocess_exec(
                    'gst-launch-1.0',
                    '-q',
                    '-e',
                    'pipewiresrc',
                    'do-timestamp=true',
                    f'num-buffers={FALLBACK_NUM_BUFFERS}',
                    '!',
                    'videoconvert',
                    '!',
                    'video/x-raw,format=RGB',
                    '!',
                    'fdsink',
                    'fd=1',
                    stdout=PIPE,
                    stderr=PIPE,
                    env=env
                )

            timed_out = False
            try:
                out, err = await asyncio.wait_for(proc.communicate(), timeout=2.5)
            except asyncio.TimeoutError:
                timed_out = True
                logger.warning(f"Attempt {attempt}: GStreamer timed out after 2.5s, sending SIGINT")
                proc.send_signal(signal.SIGINT)
                try:
                    out, err = await asyncio.wait_for(proc.communicate(), timeout=1)
                except asyncio.TimeoutError:
                    logger.error(f"Attempt {attempt}: GStreamer did not exit within 1s after SIGINT, killing process")
                    proc.kill()
                    out, err = await proc.communicate()

            stderr_output = err.decode().strip()
            if stderr_output:
                logger.debug(f"Attempt {attempt}: GStreamer stderr: {stderr_output}")
            logger.debug(f"Attempt {attempt}: GStreamer return code: {proc.returncode} (timed_out={timed_out})")

            if "target not found" in stderr_output:
                # source node is gone (likely a mode switch), retries won't bring it back
                logger.warning("Pipewire source not found, skipping retries")
                break

            if self._has_pngenc:
                if not os.path.exists(screenshot_path):
                    logger.warning(f"Attempt {attempt}: screenshot file not created")
                    continue

                size = os.path.getsize(screenshot_path)
                if size < MIN_VALID_SIZE:
                    logger.warning(f"Attempt {attempt}: screenshot too small ({size} bytes, min {MIN_VALID_SIZE}) - likely corrupted frame")
                    continue

                base64_data = get_base64_image(screenshot_path)
                if not base64_data:
                    logger.warning(f"Attempt {attempt}: base64 encoding failed for {screenshot_path}")
                    continue

                logger.debug(f"Screenshot saved ({size} bytes) on attempt {attempt}")
                return {"path": screenshot_path, "base64": base64_data}
            else:
                fw, fh = self._fallback_dims
                expected_bytes = fw * fh * 3
                if len(out) != expected_bytes:
                    # Source resolution changed (may be dock/undock) - invalidate cache
                    logger.warning(f"Attempt {attempt}: raw size {len(out)} != expected {expected_bytes} for {fw}x{fh}; re-probing dims next call")
                    self._fallback_dims = None
                    continue

                frame = out

                try:
                    from PIL import Image, ImageStat
                    from io import BytesIO
                    img = Image.frombytes("RGB", (fw, fh), frame)
                except Exception as e:
                    logger.warning(f"Attempt {attempt}: Pillow decode failed: {e}")
                    continue

                if max(ImageStat.Stat(img).stddev) < FALLBACK_STDDEV_THRESHOLD:
                    logger.warning(f"Attempt {attempt}: frame too uniform (stddev < {FALLBACK_STDDEV_THRESHOLD}) - likely warmup garbage")
                    continue

                buf = BytesIO()
                img.save(buf, "PNG", optimize=False)
                png_bytes = buf.getvalue()

                with open(screenshot_path, "wb") as f:
                    f.write(png_bytes)
                base64_data = base64.b64encode(png_bytes).decode("utf-8")

                logger.debug(f"Screenshot saved via Pillow ({len(png_bytes)} bytes) on attempt {attempt}")
                return {"path": screenshot_path, "base64": base64_data}

        logger.error(f"Screenshot capture failed after {attempt} attempt(s)")
        self._capture_backend = None
        return {"path": "", "base64": ""}

    async def _take_screenshot_spectacle(self, env, screenshot_path, MIN_VALID_SIZE):
        # PyInstaller injects LD_LIBRARY_PATH=/tmp/_MEIxxx/ which has older libs that break Qt-linked binaries.
        env = self._clean_system_binary_env(env)
        proc = await asyncio.create_subprocess_exec(
            '/usr/bin/spectacle', '-b', '-n', '-f', '-o', screenshot_path,
            stdout=PIPE, stderr=PIPE, env=env
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            logger.error("spectacle timed out after 5s")
            self._capture_backend = None
            return {"path": "", "base64": ""}

        if proc.returncode != 0 or not os.path.exists(screenshot_path):
            logger.error(f"spectacle failed: rc={proc.returncode} stderr={err.decode(errors='ignore').strip()}")
            self._capture_backend = None
            return {"path": "", "base64": ""}

        size = os.path.getsize(screenshot_path)
        if size < MIN_VALID_SIZE:
            logger.warning(f"spectacle screenshot too small ({size} bytes, min {MIN_VALID_SIZE})")
            self._capture_backend = None
            return {"path": "", "base64": ""}

        base64_data = get_base64_image(screenshot_path)
        if not base64_data:
            logger.warning(f"spectacle base64 encoding failed for {screenshot_path}")
            return {"path": "", "base64": ""}

        logger.debug(f"Screenshot saved via spectacle ({size} bytes)")
        return {"path": screenshot_path, "base64": base64_data}

    async def _take_screenshot_portal(self, env, screenshot_path, MIN_VALID_SIZE):
        # Result arrives as a Request.Response signal; start gdbus monitor before issuing the call to avoid a race.
        env = self._clean_system_binary_env(env)
        handle_token = f"deckytutor_{int(time.time() * 1000)}"

        # stdbuf -oL: gdbus block-buffers when stdout is a pipe, so the Response signal stays unread until exit.
        monitor = await asyncio.create_subprocess_exec(
            '/usr/bin/stdbuf', '-oL',
            '/usr/bin/gdbus', 'monitor', '--session',
            '--dest', 'org.freedesktop.portal.Desktop',
            stdout=PIPE, stderr=PIPE, env=env
        )

        try:
            options = f"{{'interactive': <false>, 'modal': <false>, 'handle_token': <'{handle_token}'>}}"
            call = await asyncio.create_subprocess_exec(
                '/usr/bin/gdbus', 'call', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop',
                '--method', 'org.freedesktop.portal.Screenshot.Screenshot',
                '', options,
                stdout=PIPE, stderr=PIPE, env=env
            )
            _, call_err = await asyncio.wait_for(call.communicate(), timeout=3.0)
            if call.returncode != 0:
                logger.error(f"portal Screenshot call failed: {call_err.decode(errors='ignore').strip()}")
                self._capture_backend = None
                return {"path": "", "base64": ""}

            uri = None
            deadline = asyncio.get_event_loop().time() + 8.0
            while True:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    line = await asyncio.wait_for(monitor.stdout.readline(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                if not line:
                    break
                s = line.decode(errors='ignore')
                if handle_token not in s or "Response" not in s:
                    continue
                m = re.search(r"'uri':\s*<'(file://[^']+)'>", s)
                if m:
                    uri = m.group(1)
                    break

            if not uri:
                logger.error("portal Screenshot timed out waiting for Response signal")
                self._capture_backend = None
                return {"path": "", "base64": ""}

            src = unquote(urlparse(uri).path)
            shutil.copyfile(src, screenshot_path)
            try:
                os.remove(src)
            except OSError:
                pass

            size = os.path.getsize(screenshot_path)
            if size < MIN_VALID_SIZE:
                logger.warning(f"portal screenshot too small ({size} bytes, min {MIN_VALID_SIZE})")
                self._capture_backend = None
                return {"path": "", "base64": ""}

            base64_data = get_base64_image(screenshot_path)
            if not base64_data:
                logger.warning(f"portal base64 encoding failed for {screenshot_path}")
                return {"path": "", "base64": ""}

            logger.debug(f"Screenshot saved via portal ({size} bytes)")
            return {"path": screenshot_path, "base64": base64_data}

        finally:
            try:
                monitor.kill()
                await monitor.communicate()
            except Exception:
                pass

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

    async def recognize_text(self, image_data: str, learn_mode: bool = False):
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

            if self._ocr_provider == "chromescreenai" and not self._provider_manager.is_chromescreenai_downloaded():
                return {"error": "model_not_available", "message": "Chrome Screen AI engine not downloaded.\nDownload it in plugin settings"}

            if self._ocr_provider == "rapidocr" and not self._provider_manager.is_rapidocr_models_downloaded():
                return {"error": "model_not_available", "message": "RapidOCR model not downloaded.\nDownload it in plugin settings"}

            # If using Gemini Vision, set the target language before OCR
            # so it can translate in the same API call
            if self._ocr_provider == "gemini_vision":
                if learn_mode:
                    return {"error": "model_not_available", "message": "Select another OCR provider for Learn Mode"}
                self._provider_manager.set_gemini_target_language(self._target_language)

            start_time = time.time()
            text_regions = await self._provider_manager.recognize_text(
                image_bytes,
                language="en" if learn_mode else self._input_language
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
            return {"error": "api_key_error", "message": str(e) or "Invalid API key"}
        except RateLimitError as e:
            logger.error(f"Rate limit during OCR: {e}")
            return {"error": "rate_limit_error", "message": str(e)}
        except Exception as e:
            logger.error(f"Text recognition error: {e}")
            logger.error(traceback.format_exc())
            return []

    async def recognize_text_file(self, image_path: str, learn_mode: bool = False):
        try:
            if not os.path.exists(image_path):
                logger.error(f"Image file does not exist: {image_path}")
                return []

            base64_data = get_base64_image(image_path)
            if not base64_data:
                logger.error("Failed to encode image for OCR")
                return []

            return await Plugin.recognize_text(self, base64_data, learn_mode)
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

            # If regions already have translatedText (e.g. from Gemini Vision),
            # skip the translation step entirely
            if all(r.get("translatedText") is not None for r in text_regions):
                logger.info(f"Translation skipped: {len(text_regions)} regions already translated by OCR provider")
                if (self._translation_cache_enabled and self._translation_cache
                        and self._ocr_provider == "gemini_vision"):
                    pairs = [(r["text"], r["translatedText"]) for r in text_regions]
                    if any(normalize(s) != normalize(t) for s, t in pairs):
                        await asyncio.to_thread(
                            self._translation_cache.put_many,
                            pairs, input_lang, target_lang,
                            PROVIDER_TIERS.get("gemini_vision", 0), "gemini_vision",
                        )
                return text_regions

            # Check if CT2 provider has the needed models
            if self._translation_provider == "ct2":
                provider = self._provider_manager.get_translation_provider()
                if provider and not provider.is_available(input_lang, target_lang):
                    if input_lang == "auto":
                        return {"error": "model_not_available", "message": "Offline translation requires a specific source language. Select one in plugin settings"}
                    return {"error": "model_not_available", "message": "Offline model not found. Download it in plugin settings"}

            # Only translate regions that don't already have translatedText
            texts_to_translate = [
                region["text"] for region in text_regions
                if region.get("translatedText") is None
            ]

            cache_on = self._translation_cache_enabled and self._translation_cache is not None
            provider_tier = PROVIDER_TIERS.get(self._translation_provider, 0)

            cached = {}
            if cache_on and texts_to_translate:
                cached = await asyncio.to_thread(
                    self._translation_cache.get_many,
                    texts_to_translate, input_lang, target_lang, provider_tier,
                )

            if cache_on:
                to_request, seen = [], set()
                for t in texts_to_translate:
                    if t not in cached and t not in seen:
                        seen.add(t)
                        to_request.append(t)
            else:
                to_request = texts_to_translate

            start_time = time.time()
            requested = await self._provider_manager.translate_text(
                to_request, source_lang=input_lang, target_lang=target_lang
            ) if to_request else []
            elapsed = time.time() - start_time
            logger.info(f"Translation completed in {elapsed:.2f}s, {len(to_request)} new / {len(cached)} cached")
            for i, (src, dst) in enumerate(zip(to_request, requested)):
                logger.debug(f"  [{i}] '{src}' -> '{dst}'")

            # Failed items come back as None
            translated = [(s, t) for s, t in zip(to_request, requested) if t is not None]
            if cache_on and any(normalize(s) != normalize(t) for s, t in translated):
                await asyncio.to_thread(
                    self._translation_cache.put_many,
                    translated, input_lang, target_lang, provider_tier, self._translation_provider,
                )

            # A failed item shows its original text.
            result_map = {s: (t if t is not None else s) for s, t in zip(to_request, requested)}
            result_map.update(cached)

            translated_regions = []
            for region in text_regions:
                if region.get("translatedText") is not None:
                    translated_regions.append(region)
                else:
                    text = region["text"]
                    translated_regions.append({
                        **region,
                        "translatedText": result_map.get(text, text)
                    })

            logger.debug(f"Returning {len(translated_regions)} translated regions (from {len(text_regions)} input regions)")
            return translated_regions

        except NetworkError as e:
            logger.error(f"Network error during translation: {e}")
            return {"error": "network_error", "message": str(e)}
        except ApiKeyError as e:
            logger.error(f"API key error during translation: {e}")
            return {"error": "api_key_error", "message": str(e) or "Invalid API key"}
        except RateLimitError as e:
            logger.error(f"Rate limit during translation: {e}")
            return {"error": "rate_limit_error", "message": str(e)}
        except Exception as e:
            logger.error(f"Translation error: {e}")
            logger.error(traceback.format_exc())
            return None

    async def get_enabled_state(self):
        return await self.get_setting("enabled", True)

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

    async def clear_translation_cache(self):
        try:
            if not self._translation_cache:
                return {"success": False, "cleared": 0}
            cleared = await asyncio.to_thread(self._translation_cache.clear)
            return {"success": True, "cleared": cleared}
        except Exception as e:
            logger.error(f"Error clearing translation cache: {e}")
            return {"success": False, "error": str(e)}

    async def get_translation_cache_stats(self):
        try:
            if not self._translation_cache:
                return {"entries": 0, "hits": 0, "size_bytes": 0}
            return await asyncio.to_thread(self._translation_cache.stats)
        except Exception as e:
            logger.error(f"Error getting translation cache stats: {e}")
            return {"entries": 0, "hits": 0, "size_bytes": 0}

    async def get_translation_cache_entries(self, limit: int = 300):
        try:
            if not self._translation_cache:
                return []
            return await asyncio.to_thread(self._translation_cache.list_entries, limit)
        except Exception as e:
            logger.error(f"Error getting translation cache entries: {e}")
            return []

    async def delete_translation_cache_entry(self, source_lang, target_lang, source_text):
        try:
            if not self._translation_cache:
                return {"success": False}
            removed = await asyncio.to_thread(
                self._translation_cache.delete_entry, source_lang, target_lang, source_text
            )
            return {"success": True, "removed": removed}
        except Exception as e:
            logger.error(f"Error deleting translation cache entry: {e}")
            return {"success": False, "error": str(e)}

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

            if self._triton_monitor is None:
                self._triton_monitor = TritonHidrawMonitor()
            if not self._triton_monitor.running:
                self._triton_monitor.start()

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
            if self._triton_monitor:
                self._triton_monitor.stop()
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

            if self._triton_monitor and self._triton_monitor.running:
                any_running = True
                buttons.update(self._triton_monitor.get_button_state())

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

            if self._triton_monitor:
                status["triton"] = self._triton_monitor.get_status()
            else:
                status["triton"] = {"running": False, "initialized": False}

            return {"success": True, "status": status}
        except Exception as e:
            logger.error(f"Error getting hidraw status: {e}")
            return {"success": False, "error": str(e)}

    # -- NLLB model management API --

    async def get_nllb_model_status(self):
        try:
            if not self._provider_manager:
                return {"downloaded": False, "size": 0, "downloading": False, "progress": 0, "error": None}
            return self._provider_manager.get_nllb_model_status()
        except Exception as e:
            logger.error(f"Error getting NLLB model status: {e}")
            return {"downloaded": False, "size": 0, "downloading": False, "progress": 0, "error": str(e)}

    async def download_nllb_model(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.download_nllb_model()
        except Exception as e:
            logger.error(f"Error starting NLLB model download: {e}")
            return False

    async def delete_nllb_model(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.delete_nllb_model()
        except Exception as e:
            logger.error(f"Error deleting NLLB model: {e}")
            return False

    async def cancel_nllb_download(self):
        try:
            if self._provider_manager:
                self._provider_manager.cancel_nllb_download()
            return True
        except Exception as e:
            logger.error(f"Error cancelling NLLB download: {e}")
            return False

    async def clear_nllb_model_error(self):
        try:
            if self._provider_manager:
                self._provider_manager.clear_nllb_download_error()
            return True
        except Exception as e:
            logger.error(f"Error clearing NLLB download error: {e}")
            return False

    # -- Chrome Screen AI download API --

    async def get_chromescreenai_status(self):
        try:
            if not self._provider_manager:
                return {"downloaded": False, "size": 0, "approx_size_mb": 120,
                        "downloading": False, "progress": 0, "error": None}
            return self._provider_manager.get_chromescreenai_status()
        except Exception as e:
            logger.error(f"Error getting Chrome Screen AI status: {e}")
            return {"downloaded": False, "size": 0, "approx_size_mb": 120,
                    "downloading": False, "progress": 0, "error": str(e)}

    async def download_chromescreenai(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.download_chromescreenai()
        except Exception as e:
            logger.error(f"Error starting Chrome Screen AI download: {e}")
            return False

    async def cancel_chromescreenai_download(self):
        try:
            if self._provider_manager:
                self._provider_manager.cancel_chromescreenai_download()
            return True
        except Exception as e:
            logger.error(f"Error cancelling Chrome Screen AI download: {e}")
            return False

    async def clear_chromescreenai_error(self):
        try:
            if self._provider_manager:
                self._provider_manager.clear_chromescreenai_error()
            return True
        except Exception as e:
            logger.error(f"Error clearing Chrome Screen AI error: {e}")
            return False

    async def delete_chromescreenai(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.delete_chromescreenai()
        except Exception as e:
            logger.error(f"Error deleting Chrome Screen AI files: {e}")
            return False

    # -- RapidOCR model download API --

    async def get_rapidocr_models_status(self):
        try:
            if not self._provider_manager:
                return {"downloaded": False, "size": 0, "approx_size_mb": 75,
                        "downloading": False, "progress": 0, "error": None}
            return self._provider_manager.get_rapidocr_models_status()
        except Exception as e:
            logger.error(f"Error getting RapidOCR models status: {e}")
            return {"downloaded": False, "size": 0, "approx_size_mb": 75,
                    "downloading": False, "progress": 0, "error": str(e)}

    async def download_rapidocr_models(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.download_rapidocr_models()
        except Exception as e:
            logger.error(f"Error starting RapidOCR models download: {e}")
            return False

    async def cancel_rapidocr_models_download(self):
        try:
            if self._provider_manager:
                self._provider_manager.cancel_rapidocr_models_download()
            return True
        except Exception as e:
            logger.error(f"Error cancelling RapidOCR models download: {e}")
            return False

    async def clear_rapidocr_models_error(self):
        try:
            if self._provider_manager:
                self._provider_manager.clear_rapidocr_models_error()
            return True
        except Exception as e:
            logger.error(f"Error clearing RapidOCR models error: {e}")
            return False

    async def delete_rapidocr_models(self):
        try:
            if not self._provider_manager:
                return False
            return self._provider_manager.delete_rapidocr_models()
        except Exception as e:
            logger.error(f"Error deleting RapidOCR models: {e}")
            return False

    async def _main(self):
        logger.info("Plugin initialization started")
        try:
            self._settings = SettingsManager(
                name="decky-language-tutor-settings",
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
            self._translation_cache_enabled = bool(
                load_setting("translation_cache_enabled", self._translation_cache_enabled)
            )

            os.makedirs(self._screenshotPath, exist_ok=True)

            def load_api_key(name):
                raw = self._settings.get_setting(name, "")
                cleaned = _clean_api_key(raw)
                if cleaned != raw:
                    logger.warning(
                        f"{name} contained whitespace or invisible characters, "
                        f"cleaned (len {len(raw)} -> {len(cleaned)})"
                    )
                    self._settings.set_setting(name, cleaned)
                if cleaned:
                    logger.info(f"{name} loaded (len={len(cleaned)})")
                return cleaned

            google_api_key = load_api_key("google_api_key")
            if google_api_key:
                self._google_vision_api_key = google_api_key
                self._google_translate_api_key = google_api_key

            gemini_api_key = load_api_key("gemini_api_key")
            if gemini_api_key:
                self._gemini_api_key = gemini_api_key
            self._gemini_model = self._settings.get_setting("gemini_model", "gemini-2.5-flash")

            saved_ocr_provider = self._settings.get_setting("ocr_provider")
            if saved_ocr_provider is not None:
                self._ocr_provider = saved_ocr_provider
                self._use_free_providers = (saved_ocr_provider != "googlecloud")
            else:
                self._settings.set_setting("ocr_provider", self._ocr_provider)

            # One-shot migration of the old rapidocr default to chromescreenai
            if not self._settings.get_setting("default_ocr_provider_migrated_v1", False):
                if saved_ocr_provider == "rapidocr":
                    self._ocr_provider = "chromescreenai"
                    self._use_free_providers = True
                    self._settings.set_setting("ocr_provider", "chromescreenai")
                    logger.info("Migrated default OCR provider rapidocr -> chromescreenai")
                self._settings.set_setting("default_ocr_provider_migrated_v1", True)

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

            # Set up CT2 translation models directory
            ct2_models_dir = os.path.join(settingsDir, "models", "nllb")
            os.makedirs(ct2_models_dir, exist_ok=True)

            # Same parent as NLLB so both share the plugin uninstall lifecycle.
            screenai_models_dir = os.path.join(settingsDir, "models")
            os.makedirs(screenai_models_dir, exist_ok=True)

            # RapidOCR models download into the same parent dir as NLLB and
            # Chrome Screen AI so they all persist across plugin updates.

            try:
                self._translation_cache = TranslationCache(
                    os.path.join(settingsDir, "translation_cache.db")
                )
            except Exception as e:
                logger.error(f"Failed to open translation cache, continuing without it: {e}")
                self._translation_cache = None

            # Initialize provider manager
            self._provider_manager = ProviderManager()
            self._provider_manager.configure(
                use_free_providers=self._use_free_providers,
                google_api_key=google_api_key,
                gemini_api_key=gemini_api_key,
                ocr_provider=self._ocr_provider,
                translation_provider=self._translation_provider,
                ct2_models_dir=ct2_models_dir,
                screenai_models_dir=screenai_models_dir,
                rapidocr_models_dir=screenai_models_dir,
                ocrspace_data_dir=settingsDir,
            )

            # Load and apply RapidOCR-specific settings
            if self._settings.get_setting("custom_recognition_settings", False):
                self._rapidocr_confidence = load_setting("rapidocr_confidence", self._rapidocr_confidence)
                self._rapidocr_box_thresh = load_setting("rapidocr_box_thresh", self._rapidocr_box_thresh)
                self._rapidocr_unclip_ratio = load_setting("rapidocr_unclip_ratio", self._rapidocr_unclip_ratio)
            self._rapidocr_persistent_mode = bool(
                load_setting("rapidocr_persistent_mode", self._rapidocr_persistent_mode)
            )
            self._chromescreenai_persistent_mode = bool(
                load_setting("chromescreenai_persistent_mode", self._chromescreenai_persistent_mode)
            )
            self._ct2_persistent_mode = bool(
                load_setting("ct2_persistent_mode", self._ct2_persistent_mode)
            )
            self._provider_manager.set_rapidocr_confidence(self._rapidocr_confidence)
            self._provider_manager.set_rapidocr_box_thresh(self._rapidocr_box_thresh)
            self._provider_manager.set_rapidocr_unclip_ratio(self._rapidocr_unclip_ratio)
            # Only spin up the worker if the plugin is enabled right now;
            # the preference is always stored so re-enable can pick it up.
            plugin_enabled_at_boot = self._settings.get_setting("enabled", True)
            self._provider_manager.set_rapidocr_persistent_mode(
                self._rapidocr_persistent_mode,
                apply_to_provider=plugin_enabled_at_boot,
            )
            self._provider_manager.set_chromescreenai_persistent_mode(
                self._chromescreenai_persistent_mode,
                apply_to_provider=plugin_enabled_at_boot
                                  and self._ocr_provider == "chromescreenai",
            )
            self._provider_manager.set_ct2_persistent_mode(
                self._ct2_persistent_mode,
                apply_to_provider=plugin_enabled_at_boot
                                  and self._translation_provider == "ct2",
            )

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

            self._triton_monitor = TritonHidrawMonitor()
            if self._triton_monitor.start():
                logger.info("Triton hidraw monitor started")
            else:
                logger.info("Triton hidraw monitor not started")

        except Exception as e:
            logger.error(f"Error during initialization: {e}")
            logger.error(traceback.format_exc())
        return

    async def _unload(self):
        logger.info("Unloading plugin")
        try:
            if self._provider_manager:
                self._provider_manager.shutdown()

            if self._translation_cache:
                self._translation_cache.close()
                self._translation_cache = None

            if self._evdev_monitor:
                self._evdev_monitor.stop()
                self._evdev_monitor = None

            if self._triton_monitor:
                self._triton_monitor.stop()
                self._triton_monitor = None

            if self._hidraw_monitor:
                self._hidraw_monitor.stop()
                self._hidraw_monitor = None

            std_out_file.close()
            std_err_file.close()
        except Exception as e:
            logger.error(f"Error during plugin unload: {e}")
            logger.error(traceback.format_exc())
        return
