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
import decky_plugin
import logging
import shutil
import json
import base64  # Add base64 module for encoding screenshots
import urllib3
import requests
from PIL import Image
import io

# Add plugin directory to Python path for local imports
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

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
logger.info(f"DECKY_PLUGIN_DIR: {DECKY_PLUGIN_DIR}")
logger.info(f"DECKY_PLUGIN_LOG_DIR: {DECKY_PLUGIN_LOG_DIR}")
logger.info(f"DECKY_HOME: {DECKY_HOME}")
logger.info(f"Dependencies path: {DEPSPATH}")
logger.info(f"GStreamer plugins path: {GSTPLUGINSPATH}")

# Ensure log directory exists
os.makedirs(DECKY_PLUGIN_LOG_DIR, exist_ok=True)
logger.info(f"Log directory ensured: {DECKY_PLUGIN_LOG_DIR}")

# Set up log files
std_out_file_path = Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator-std-out.log"
std_out_file = open(std_out_file_path, "w")
std_err_file = open(Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator-std-err.log", "w")
logger.info(f"Standard output logs: {std_out_file_path}")

# Set up file logging
from logging.handlers import TimedRotatingFileHandler

log_file = Path(DECKY_PLUGIN_LOG_DIR) / "decky-translator.log"
log_file_handler = TimedRotatingFileHandler(log_file, when="midnight", backupCount=2)
log_file_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
logger.handlers.clear()
logger.addHandler(log_file_handler)
logger.setLevel(logging.DEBUG)  # Setting logger to DEBUG level for more verbose output
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
        logger.info("HidrawButtonMonitor initialized")

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
        import select
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
        """Stop the monitoring thread and close device."""
        logger.info("Stopping HidrawButtonMonitor")
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


class SettingsManager:
    def __init__(self, name, settings_directory):
        self.settings_path = os.path.join(settings_directory, f"{name}.json")
        self.settings = {}
        logger.info(f"SettingsManager initialized with path: {self.settings_path}")

    def read(self):
        try:
            if os.path.exists(self.settings_path):
                with open(self.settings_path, 'r') as f:
                    self.settings = json.load(f)
                logger.info(f"Settings loaded from {self.settings_path}: {json.dumps(self.settings)}")
            else:
                logger.warning(f"Settings file does not exist: {self.settings_path}")
        except Exception as e:
            logger.error(f"Failed to read settings: {str(e)}")
            logger.error(traceback.format_exc())
            self.settings = {}

    def set_setting(self, key, value):
        try:
            previous_value = self.settings.get(key, "not_set")
            self.settings[key] = value
            logger.info(f"Setting {key} changing from {previous_value} to {value}")

            # Create directory if it doesn't exist
            os.makedirs(os.path.dirname(self.settings_path), exist_ok=True)

            with open(self.settings_path, 'w') as f:
                json.dump(self.settings, f, indent=4)
            logger.info(f"Setting {key} saved to {self.settings_path}")
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
        logger.info(f"Executing command: {cmd}")

    try:
        output = subprocess.getoutput(cmd).strip()
        logger.info(f"Command output: {output[:100]}{'...' if len(output) > 100 else ''}")
        return output
    except Exception as e:
        logger.error(f"Command execution failed: {str(e)}")
        logger.error(traceback.format_exc())
        return f"Error: {str(e)}"


def get_all_children(pid: int) -> list[str]:
    logger.info(f"get_all_children: Starting to find children processes for pid {pid}")
    pids = []
    tmpPids = [str(pid)]
    try:
        while tmpPids:
            ppid = tmpPids.pop(0)
            logger.debug(f"get_all_children: Processing parent pid {ppid}")
            lines = []
            cmd = ["ps", "--ppid", ppid, "-o", "pid="]
            logger.debug(f"get_all_children: Running command: {' '.join(cmd)}")
            with subprocess.Popen(cmd, stdout=subprocess.PIPE) as p:
                lines = p.stdout.readlines()

            logger.debug(f"get_all_children: Found {len(lines)} child processes for ppid {ppid}")
            for chldPid in lines:
                # Important: decode bytes to str!
                if isinstance(chldPid, bytes):
                    chldPid = chldPid.decode('utf-8')
                chldPid = chldPid.strip()
                if not chldPid:
                    continue
                logger.debug(f"get_all_children: Adding child pid {chldPid}")
                pids.append(chldPid)
                tmpPids.append(chldPid)

        logger.info(f"get_all_children: Found total {len(pids)} child processes: {pids}")
        return pids
    except Exception as e:
        logger.error(f"get_all_children: Error finding child processes: {e}")
        logger.error(traceback.format_exc())
        return pids


def get_base64_image(image_path):
    """Read an image file and convert it to base64 string"""
    logger.info(f"Starting base64 encoding of image: {image_path}")
    try:
        # Make sure the file exists and is readable
        if not os.path.exists(image_path):
            logger.error(f"Image file does not exist: {image_path}")
            return ""

        # Get file size for logging
        file_size = os.path.getsize(image_path)
        logger.info(f"Reading image file: {image_path} (size: {file_size} bytes)")

        # Check if file size is reasonable
        if file_size > 10 * 1024 * 1024:  # 10MB limit
            logger.warning(f"Image file is very large ({file_size} bytes), encoding may take time")

        # Try to read the entire file
        try:
            with open(image_path, "rb") as image_file:
                logger.debug(f"File opened successfully, reading content...")
                content = image_file.read()  # Read the entire file
                logger.debug(f"Content read successfully, size: {len(content)} bytes")
                encoded_string = base64.b64encode(content).decode('utf-8')
                logger.info(f"Base64 encoding successful for full image, length: {len(encoded_string)}")
                return encoded_string
        except MemoryError:
            logger.error("Memory error when encoding full image to base64, trying with 1MB chunk")
            with open(image_path, "rb") as image_file:
                content = image_file.read(1024 * 1024)  # Try with 1MB
                encoded_string = base64.b64encode(content).decode('utf-8')
                logger.info(f"Base64 encoding successful with 1MB chunk, length: {len(encoded_string)}")
                return encoded_string
    except Exception as e:
        logger.error(f"Failed to convert image to base64: {str(e)}")
        logger.error(traceback.format_exc())

        # Try one last time with a very small chunk as fallback
        try:
            logger.debug("Attempting last-resort encoding with small chunk size")
            with open(image_path, "rb") as image_file:
                content = image_file.read(50 * 1024)  # Last attempt with 50KB
                encoded_string = base64.b64encode(content).decode('utf-8')
                logger.info(f"Base64 encoding successful with 50KB chunk, length: {len(encoded_string)}")
                return encoded_string
        except Exception as inner_e:
            logger.error(f"All base64 encoding attempts failed: {str(inner_e)}")
            logger.error(traceback.format_exc())
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

    # Provider system
    _provider_manager: ProviderManager = None
    _use_free_providers: bool = True  # Default to free providers (no API key needed)
    _ocr_provider: str = "rapidocr"  # "rapidocr" (RapidOCR), "ocrspace" (OCR.space), or "googlecloud" (Google Cloud)

    # OCR API configurations - user must provide their own API key
    _google_vision_api_key: str = ""
    _google_translate_api_key: str = ""

    # Generic settings handlers
    async def get_setting(self, key, default=None):
        """Generic method to get any setting by key"""
        logger.info(f"Getting setting: {key}, default: {default}")
        return self._settings.get_setting(key, default)

    async def set_setting(self, key, value):
        """Generic method to set any setting by key"""
        logger.info(f"Setting {key} to: {value}")
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
                        google_api_key=value
                    )
            elif key == "google_vision_api_key":
                self._google_vision_api_key = value
                # Update provider manager with new API key
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=self._use_free_providers,
                        google_api_key=value
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
            elif key == "use_free_providers":
                self._use_free_providers = value
                # Update provider manager configuration (backwards compatibility)
                if self._provider_manager:
                    self._provider_manager.configure(
                        use_free_providers=value,
                        google_api_key=self._google_vision_api_key
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
                        ocr_provider=value
                    )
            else:
                logger.warning(f"Unknown setting key: {key}")

            success = self._settings.set_setting(key, value)
            logger.info(f"Saved setting {key}: {success}")
            return success
        except Exception as e:
            logger.error(f"Error setting {key}: {str(e)}")
            logger.error(traceback.format_exc())
            return False

    async def get_all_settings(self):
        """Get all settings at once"""
        logger.info("Getting all settings")
        try:
            settings = {
                "target_language": self._target_language,
                "input_language": self._input_language,
                "input_mode": self._input_mode,
                "enabled": self._settings.get_setting("enabled", True),
                "use_free_providers": self._use_free_providers,
                "ocr_provider": self._ocr_provider,
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
                "debug_mode": self._settings.get_setting("debug_mode", False)
            }
            logger.info(f"Returning all settings: {json.dumps(settings)}")
            return settings
        except Exception as e:
            logger.error(f"Error getting all settings: {str(e)}")
            logger.error(traceback.format_exc())
            return {}

    async def get_provider_status(self):
        """Get current provider status including usage stats."""
        logger.info("Getting provider status")
        try:
            if self._provider_manager:
                return self._provider_manager.get_provider_status()
            return {"error": "Provider manager not initialized"}
        except Exception as e:
            logger.error(f"Error getting provider status: {str(e)}")
            return {"error": str(e)}

    async def take_screenshot(self, app_name: str = ""):
        logger.info(f"Taking screenshot for app: {app_name}")
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
            logger.info(f"Screenshot will be saved to: {screenshot_path}")

            # Prepare environment
            env = os.environ.copy()
            env.update({
                "XDG_RUNTIME_DIR": "/run/user/1000",
                "XDG_SESSION_TYPE": "wayland",
                "HOME": DECKY_HOME
            })

            # GStreamer pipeline: grab one frame then EOS
            cmd = (
                # keep only the path to your plugins, without GST_VAAPI_ALL_DRIVERS
                f"GST_PLUGIN_PATH={GSTPLUGINSPATH} "
                f"LD_LIBRARY_PATH={DEPSPATH} "
                f"gst-launch-1.0 -e "
                # capture one buffer
                f"pipewiresrc do-timestamp=true num-buffers=1 ! "
                # let videoconvert work by default (CPU), it will create normal raw
                f"videoconvert ! "
                # then directly to PNG
                f"pngenc snapshot=true ! "
                f"filesink location=\"{screenshot_path}\""
            )
            logger.info(f"GStreamer screenshot command: {cmd}")

            # Launch subprocess asynchronously
            proc = await asyncio.create_subprocess_exec(
                'gst-launch-1.0',
                '-e',
                'pipewiresrc',
                'do-timestamp=true',
                'num-buffers=1',
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
            logger.error(f"GStreamer stderr: {err.decode().strip() or 'None'}")
            logger.info(f"GStreamer return code: {proc.returncode}")

            # Give the filesystem a moment - seems to work without it
            # await asyncio.sleep(0.25)

            # Check file and return
            if os.path.exists(screenshot_path) and os.path.getsize(screenshot_path) > 0:
                size = os.path.getsize(screenshot_path)
                logger.info(f"Screenshot saved ({size} bytes)")
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

    # Save configurations
    async def saveConfig(self):
        logger.info("Saving config")
        try:
            if self._settings:
                success1 = self._settings.set_setting("target_language", self._target_language)
                success2 = self._settings.set_setting("google_api_key", self._google_vision_api_key)  # Save unified key
                success3 = self._settings.set_setting("input_mode", self._input_mode)
                success4 = self._settings.set_setting("input_language", self._input_language)
                success5 = self._settings.set_setting("hold_time_translate", self._hold_time_translate)
                success6 = self._settings.set_setting("hold_time_dismiss", self._hold_time_dismiss)
                success7 = self._settings.set_setting("confidence_threshold", self._confidence_threshold)
                success8 = self._settings.set_setting("pause_game_on_overlay", self._pause_game_on_overlay)
                success9 = self._settings.set_setting("quick_toggle_enabled", self._quick_toggle_enabled)

                logger.debug(f"Save results - target_language: {success1}, " +
                             f"vision_api_key: {success2}, input_mode: {success3}, " +
                             f"input_language: {success4}, hold_time_translate: {success5}, " +
                             f"hold_time_dismiss: {success6}, confidence_threshold: {success7}, " +
                             f"pause_game_on_overlay: {success8}, quick_toggle_enabled: {success9}")

                return (success1 and success2 and success3 and success4 and
                        success5 and success6 and success7 and success8 and success9)
            else:
                logger.error("Cannot save config - settings object is not initialized")
                return False
        except Exception as e:
            logger.error(f"Error saving config: {str(e)}")
            logger.error(traceback.format_exc())
            return False

    async def is_paused(self, pid: int) -> bool:
        logger.info(f"is_paused: Checking if process {pid} is paused")
        try:
            cmd = ["ps", "--pid", str(pid), "-o", "stat="]
            logger.debug(f"is_paused: Running command: {' '.join(cmd)}")
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                stdout, stderr = p.communicate()
                status = stdout.lstrip().decode('utf-8')
                logger.debug(f"is_paused: Process {pid} status: '{status}'")
                is_stopped = status.startswith('T')
                logger.info(f"is_paused: Process {pid} is {'paused' if is_stopped else 'not paused'}")
                return is_stopped
        except Exception as e:
            logger.error(f"is_paused: Error checking pause status: {e}")
            logger.error(traceback.format_exc())
            return False

    async def pause(self, pid: int) -> bool:
        logger.info(f"pause: Attempting to pause process with pid {pid}")
        if not pid:
            logger.error("pause: Invalid pid (zero or None)")
            return False

        pids = get_all_children(pid)
        if pids:
            # Also add the parent process to pause
            pids.insert(0, str(pid))
            logger.info(f"pause: Pausing process {pid} and {len(pids)-1} child processes: {pids}")

            command = ["kill", "-SIGSTOP"]
            command.extend(pids)

            logger.info(f"pause: Running command: {' '.join(command)}")
            try:
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                logger.info(f"pause: Command result: code={result.returncode}, stdout={result.stdout.decode().strip()}, stderr={result.stderr.decode().strip()}")

                # Verify if processes are actually paused
                is_paused_result = await self.is_paused(pid)
                logger.info(f"pause: Verification - is process {pid} paused: {is_paused_result}")

                return result.returncode == 0
            except Exception as e:
                logger.error(f"pause: Error executing pause command: {e}")
                logger.error(traceback.format_exc())
                return False
        else:
            logger.warning(f"pause: No child processes found for pid {pid}")
            # Try to pause just the parent
            try:
                logger.info(f"pause: Attempting to pause just parent process {pid}")
                command = ["kill", "-SIGSTOP", str(pid)]
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                logger.info(f"pause: Parent-only command result: code={result.returncode}, stdout={result.stdout.decode().strip()}, stderr={result.stderr.decode().strip()}")
                return result.returncode == 0
            except Exception as e:
                logger.error(f"pause: Error pausing parent process: {e}")
                logger.error(traceback.format_exc())
                return False

    async def resume(self, pid: int) -> bool:
        logger.info(f"resume: Attempting to resume process with pid {pid}")
        if not pid:
            logger.error("resume: Invalid pid (zero or None)")
            return False

        pids = get_all_children(pid)
        if pids:
            # Also add the parent process to resume
            pids.insert(0, str(pid))
            logger.info(f"resume: Resuming process {pid} and {len(pids)-1} child processes: {pids}")

            command = ["kill", "-SIGCONT"]
            command.extend(pids)

            logger.info(f"resume: Running command: {' '.join(command)}")
            try:
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                logger.info(f"resume: Command result: code={result.returncode}, stdout={result.stdout.decode().strip()}, stderr={result.stderr.decode().strip()}")

                # Verify if processes are actually resumed
                is_paused_result = await self.is_paused(pid)
                logger.info(f"resume: Verification - is process {pid} still paused: {is_paused_result}")

                return result.returncode == 0
            except Exception as e:
                logger.error(f"resume: Error executing resume command: {e}")
                logger.error(traceback.format_exc())
                return False
        else:
            logger.warning(f"resume: No child processes found for pid {pid}")
            # Try to resume just the parent
            try:
                logger.info(f"resume: Attempting to resume just parent process {pid}")
                command = ["kill", "-SIGCONT", str(pid)]
                result = subprocess.run(command, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
                logger.info(f"resume: Parent-only command result: code={result.returncode}, stdout={result.stdout.decode().strip()}, stderr={result.stderr.decode().strip()}")
                return result.returncode == 0
            except Exception as e:
                logger.error(f"resume: Error resuming parent process: {e}")
                logger.error(traceback.format_exc())
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
        logger.info(f"pid_from_appid: Looking for process with AppId={appid}")
        pid = ""
        try:
            # Original approach - looking for reaper process with AppId
            cmd = ["pgrep", "--full", "--oldest", f"/reaper\\s.*\\bAppId={appid}\\b"]
            logger.debug(f"pid_from_appid: Running command: {' '.join(cmd)}")
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                stdout, stderr = p.communicate()
                pid = stdout.strip()
                logger.debug(f"pid_from_appid: Command result: stdout={pid}, stderr={stderr.decode().strip()}")

            # If not found with primary method, try alternative method
            if not pid:
                logger.debug(f"pid_from_appid: Primary method failed, trying alternative approach")
                # Find Steam game processes directly
                cmd = ["pgrep", "-f", f"GameId={appid}"]
                logger.debug(f"pid_from_appid: Running alternative command: {' '.join(cmd)}")
                with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                    stdout, stderr = p.communicate()
                    pid = stdout.strip()
                    logger.debug(f"pid_from_appid: Alternative command result: stdout={pid}, stderr={stderr.decode().strip()}")

            if pid:
                logger.info(f"pid_from_appid: Found pid {pid} for AppId={appid}")
                return int(pid)
            else:
                logger.warning(f"pid_from_appid: No process found for AppId={appid}")
                return 0
        except Exception as e:
            logger.error(f"pid_from_appid: Error finding pid for AppId={appid}: {e}")
            logger.error(traceback.format_exc())
            return 0

    async def appid_from_pid(self, pid: int) -> int:
        logger.info(f"appid_from_pid: Looking for AppId with pid={pid}")
        # search upwards for the process that has the AppId= command line argument
        while pid and pid != 1:
            try:
                args = []
                cmdline_path = f"/proc/{pid}/cmdline"
                logger.debug(f"appid_from_pid: Reading cmdline from {cmdline_path}")
                with open(cmdline_path, "r") as f:
                    args = f.read().split('\0')

                logger.debug(f"appid_from_pid: Process {pid} cmdline arguments: {args}")
                for arg in args:
                    arg = arg.strip()
                    if arg.startswith("AppId="):
                        arg = arg.lstrip("AppId=")
                        if arg:
                            logger.info(f"appid_from_pid: Found AppId={arg} for pid={pid}")
                            return int(arg)
            except Exception as e:
                logger.debug(f"appid_from_pid: Error reading cmdline for pid={pid}: {e}")

            try:
                strppid = ""
                cmd = ["ps", "--pid", str(pid), "-o", "ppid="]
                logger.debug(f"appid_from_pid: Running command to get parent: {' '.join(cmd)}")
                with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
                    stdout, stderr = p.communicate()
                    strppid = stdout.strip()
                    logger.debug(f"appid_from_pid: Parent pid result: stdout={strppid}, stderr={stderr.decode().strip()}")

                if strppid:
                    new_pid = int(strppid)
                    logger.debug(f"appid_from_pid: Moving up to parent pid={new_pid}")
                    pid = new_pid
                else:
                    logger.warning(f"appid_from_pid: No parent found for pid={pid}")
                    break
            except Exception as e:
                logger.error(f"appid_from_pid: Error finding parent for pid={pid}: {e}")
                logger.error(traceback.format_exc())
                break

        logger.warning(f"appid_from_pid: No AppId found for pid={pid}")
        return 0

    # OCR text recognition using provider system
    async def recognize_text(self, image_data: str):
        logger.info("Starting text recognition")
        try:
            # If image_data is empty, return empty result
            if not image_data:
                logger.error("Empty image data for text recognition")
                return []

            # Log the length of input data
            logger.debug(f"Image data length: {len(image_data)}")

            # If image data starts with data:image prefix, remove it
            if image_data.startswith('data:image'):
                logger.debug("Stripping data:image prefix from image data")
                image_data = image_data.split(',', 1)[1]
                logger.debug(f"Base64 data length after stripping prefix: {len(image_data)}")

            # Decode base64 to bytes for provider
            image_bytes = base64.b64decode(image_data)

            # Use provider manager for OCR
            if not self._provider_manager:
                logger.error("Provider manager not initialized")
                return []

            start_time = time.time()
            text_regions = await self._provider_manager.recognize_text(
                image_bytes,
                language=self._input_language
            )
            elapsed_time = time.time() - start_time
            logger.info(f"OCR completed in {elapsed_time:.2f}s, found {len(text_regions)} regions")

            # Convert TextRegion objects to dicts for JSON serialization
            return [region.to_dict() for region in text_regions]

        except NetworkError as e:
            logger.error(f"Network error during text recognition: {str(e)}")
            return {"error": "network_error", "message": str(e)}
        except ApiKeyError as e:
            logger.error(f"API key error during text recognition: {str(e)}")
            return {"error": "api_key_error", "message": "Invalid API key"}
        except RateLimitError as e:
            logger.error(f"Rate limit error during text recognition: {str(e)}")
            return {"error": "rate_limit_error", "message": str(e)}
        except Exception as e:
            logger.error(f"Text recognition error: {str(e)}")
            logger.error(traceback.format_exc())
            return []

    async def recognize_text_file(self, image_path: str):
        logger.info(f"Starting file-based text recognition for image: {image_path}")
        base64_data = None
        try:
            if not os.path.exists(image_path):
                logger.error(f"Image file does not exist: {image_path}")
                return []

            base64_data = get_base64_image(image_path)
            if not base64_data:
                logger.error("Failed to encode image for OCR")
                return []

            # Call positional so 'self' is bound correctly
            return await Plugin.recognize_text(self, base64_data)
        except Exception as e:
            logger.error(f"recognize_text_file error: {e}")
            logger.error(traceback.format_exc())
            return []
        finally:
            # Clean up the temporary screenshot file regardless of success or failure
            if image_path and os.path.exists(image_path):
                try:
                    os.remove(image_path)
                    logger.info(f"Deleted temporary screenshot file: {image_path}")
                except Exception as cleanup_error:
                    logger.warning(f"Failed to delete temporary screenshot file: {cleanup_error}")

    # Translation using provider system
    async def translate_text(self, text_regions, target_language=None, input_language=None):
        logger.info(
            f"Starting text translation to {target_language or self._target_language} from {input_language or self._input_language}")
        try:
            # If no text regions, return empty result
            if not text_regions:
                logger.info("No text regions to translate")
                return []

            # Use provided target language or fall back to configured one
            target_lang = target_language or self._target_language
            input_lang = input_language or self._input_language
            logger.debug(f"Using target language: {target_lang}, input language: {input_lang}")

            # Use provider manager for translation
            if not self._provider_manager:
                logger.error("Provider manager not initialized")
                return None

            # Extract texts from regions
            texts_to_translate = []
            for idx, region in enumerate(text_regions):
                texts_to_translate.append(region["text"])
                logger.debug(
                    f"Text region {idx} for translation: '{region['text'][:30]}{'...' if len(region['text']) > 30 else ''}'")

            # Translate using provider
            start_time = time.time()
            translated_texts = await self._provider_manager.translate_text(
                texts_to_translate,
                source_lang=input_lang,
                target_lang=target_lang
            )
            elapsed_time = time.time() - start_time
            logger.info(f"Translation completed in {elapsed_time:.2f}s")

            # Combine translations with original regions
            translated_regions = []
            for i, translated_text in enumerate(translated_texts):
                if i < len(text_regions):
                    translated_region = {
                        **text_regions[i],
                        "translatedText": translated_text
                    }
                    translated_regions.append(translated_region)

            logger.info(f"Processed {len(translated_regions)} translated regions")
            return translated_regions

        except NetworkError as e:
            logger.error(f"Network error during translation: {str(e)}")
            return {"error": "network_error", "message": str(e)}
        except ApiKeyError as e:
            logger.error(f"API key error during translation: {str(e)}")
            return {"error": "api_key_error", "message": "Invalid API key"}
        except Exception as e:
            logger.error(f"Translation error: {str(e)}")
            logger.error(traceback.format_exc())
            return None

    # Get the enabled state of the plugin from settings
    async def get_enabled_state(self):
        """Get the enabled state of the plugin from settings"""
        logger.info("Getting enabled state")
        return await self.get_setting("enabled", True)

    # Set and save the enabled state of the plugin
    async def set_enabled_state(self, enabled):
        """Set and save the enabled state of the plugin"""
        logger.info(f"Setting enabled state to: {enabled}")
        return await self.set_setting("enabled", enabled)

    async def get_input_language(self):
        logger.info(f"Getting input language")
        return self._input_language

    async def set_input_language(self, language):
        logger.info(f"Setting input language to: {language}")
        return await self.set_setting("input_language", language)

    async def get_confidence_threshold(self):
        """Get the confidence threshold for text recognition"""
        logger.info(f"Getting confidence threshold")
        return self._confidence_threshold

    async def set_confidence_threshold(self, threshold: float):
        """Set the confidence threshold for text recognition"""
        logger.info(f"Setting confidence threshold to: {threshold}")
        return await self.set_setting("confidence_threshold", threshold)

    async def get_pause_game_on_overlay(self):
        """Get the setting for pausing game when overlay is shown"""
        logger.info(f"Getting pause game on overlay setting")
        return self._pause_game_on_overlay

    async def set_pause_game_on_overlay(self, enabled: bool):
        """Set whether to pause the game when overlay is shown"""
        logger.info(f"Setting pause game on overlay to: {enabled}")
        self._pause_game_on_overlay = enabled
        return await self.set_setting("pause_game_on_overlay", enabled)

    # Get the current target language
    async def get_target_language(self):
        logger.info(f"Getting target language")
        return self._target_language

    # Set a new target language
    async def set_target_language(self, language):
        logger.info(f"Setting target language to: {language}")
        return await self.set_setting("target_language", language)

    # Get the current input mode
    async def get_input_mode(self):
        logger.info(f"Getting input mode")
        return self._input_mode

    # Set a new input mode
    async def set_input_mode(self, mode):
        logger.info(f"Setting input mode to: {mode}")
        return await self.set_setting("input_mode", mode)

    # Hidraw button monitor methods
    async def start_hidraw_monitor(self):
        """Start the hidraw button monitor for low-level button detection."""
        logger.info("Starting hidraw button monitor")
        try:
            if self._hidraw_monitor is None:
                self._hidraw_monitor = HidrawButtonMonitor()

            if self._hidraw_monitor.running:
                logger.info("Hidraw monitor already running")
                return {"success": True, "message": "Already running"}

            if self._hidraw_monitor.start():
                logger.info("Hidraw monitor started successfully")
                return {"success": True, "message": "Monitor started"}
            else:
                logger.error("Failed to start hidraw monitor")
                return {"success": False, "error": "Failed to initialize device"}
        except Exception as e:
            logger.error(f"Error starting hidraw monitor: {e}")
            logger.error(traceback.format_exc())
            return {"success": False, "error": str(e)}

    async def stop_hidraw_monitor(self):
        """Stop the hidraw button monitor."""
        logger.info("Stopping hidraw button monitor")
        try:
            if self._hidraw_monitor:
                self._hidraw_monitor.stop()
                return {"success": True, "message": "Monitor stopped"}
            return {"success": True, "message": "Monitor was not running"}
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
        """Get the current complete button state from the hidraw monitor.

        This returns all currently pressed buttons, not individual events.
        This is more reliable when multiple frontends are polling.
        """
        try:
            if self._hidraw_monitor and self._hidraw_monitor.running:
                buttons = self._hidraw_monitor.get_button_state()
                return {"success": True, "buttons": buttons}
            return {"success": False, "buttons": [], "error": "Monitor not running"}
        except Exception as e:
            logger.error(f"Error getting hidraw button state: {e}")
            return {"success": False, "buttons": [], "error": str(e)}

    async def get_hidraw_status(self):
        """Get hidraw monitor status for diagnostics."""
        try:
            if self._hidraw_monitor:
                return {"success": True, "status": self._hidraw_monitor.get_status()}
            return {"success": True, "status": {"running": False, "initialized": False}}
        except Exception as e:
            logger.error(f"Error getting hidraw status: {e}")
            return {"success": False, "error": str(e)}

    async def _main(self):
        logger.info("=== Plugin initialization ===")
        try:
            # 1) Initiate SettingsManager with correct plugin-specific name
            self._settings = SettingsManager(
                name="decky-translator-settings",
                settings_directory=settingsDir
            )

            # 2) Read existing settings BEFORE setting defaults
            self._settings.read()

            # 3) Load values from settings
            # Get saved target language or use default
            saved_lang = self._settings.get_setting("target_language")
            if saved_lang:
                logger.info(f"Using saved target language: {saved_lang}")
                self._target_language = saved_lang
            else:
                logger.info(f"No saved target language, using default: {self._target_language}")
                # Only save default if no setting exists
                self._settings.set_setting("target_language", self._target_language)

            # Get saved input language or use default
            saved_input_lang = self._settings.get_setting("input_language")
            if saved_input_lang:
                logger.info(f"Using saved input language: {saved_input_lang}")
                self._input_language = saved_input_lang
            else:
                logger.info(f"No saved input language, using default: {self._input_language}")
                # Only save default if no setting exists
                self._settings.set_setting("input_language", self._input_language)

            # Get saved input mode or use default
            saved_input_mode = self._settings.get_setting("input_mode")
            if saved_input_mode is not None:
                logger.info(f"Using saved input mode: {saved_input_mode}")
                self._input_mode = saved_input_mode
            else:
                logger.info(f"No saved input mode, using default: {self._input_mode}")
                # Only save default if no setting exists
                self._settings.set_setting("input_mode", self._input_mode)

            # Get saved hold time translate or use default
            hold_time_translate = self._settings.get_setting("hold_time_translate")
            if hold_time_translate:
                logger.info(f"Using saved hold time translate: {hold_time_translate}")
                self._hold_time_translate = hold_time_translate
            else:
                logger.info(f"No saved hold time translate, using default: {self._hold_time_translate}")
                # Only save default if no setting exists
                self._settings.set_setting("hold_time_translate", self._hold_time_translate)

            # Get saved hold time dismiss or use default
            hold_time_dismiss = self._settings.get_setting("hold_time_dismiss")
            if hold_time_dismiss:
                logger.info(f"Using saved hold time dismiss: {hold_time_dismiss}")
                self._hold_time_dismiss = hold_time_dismiss
            else:
                logger.info(f"No saved hold time dismiss, using default: {self._hold_time_dismiss}")
                # Only save default if no setting exists
                self._settings.set_setting("hold_time_dismiss", self._hold_time_dismiss)

            # Get enabled state
            saved_enabled = self._settings.get_setting("enabled", True)
            logger.info(f"Plugin enabled state: {saved_enabled}")

            # Make sure the directory exists
            try:
                os.makedirs(self._screenshotPath, exist_ok=True)
                logger.debug(f"Output directory ensured: {self._screenshotPath}")
            except Exception as dir_err:
                logger.error(f"Error creating output directory: {str(dir_err)}")
                logger.error(traceback.format_exc())

            # Load Google API key (single key for both Vision and Translate)
            # Also check legacy keys for backwards compatibility
            google_api_key = self._settings.get_setting("google_api_key", "")
            if not google_api_key:
                # Fallback to legacy keys if new key not set
                google_api_key = self._settings.get_setting("google_vision_api_key", "")
            logger.info(f"Google API key length: {len(google_api_key)}")

            # Set API key if it exists in settings
            if google_api_key:
                self._google_vision_api_key = google_api_key
                self._google_translate_api_key = google_api_key
                # Save to new key format for future
                self._settings.set_setting("google_api_key", google_api_key)
            else:
                logger.info("No Google API key configured - will use free providers by default")

            # Load ocr_provider setting (new way)
            saved_ocr_provider = self._settings.get_setting("ocr_provider")
            if saved_ocr_provider is not None:
                logger.info(f"Using saved ocr_provider: {saved_ocr_provider}")
                self._ocr_provider = saved_ocr_provider
                # Derive use_free_providers for backwards compatibility
                self._use_free_providers = (saved_ocr_provider != "googlecloud")
            else:
                # Try to migrate from old use_free_providers setting
                saved_use_free = self._settings.get_setting("use_free_providers")
                if saved_use_free is not None:
                    logger.info(f"Migrating from use_free_providers: {saved_use_free}")
                    self._use_free_providers = saved_use_free
                    # Map old setting to new: True -> "rapidocr", False -> "googlecloud"
                    self._ocr_provider = "rapidocr" if saved_use_free else "googlecloud"
                else:
                    logger.info(f"No saved ocr_provider, using default: {self._ocr_provider}")
                # Save the new ocr_provider setting
                self._settings.set_setting("ocr_provider", self._ocr_provider)

            # Initialize provider manager
            logger.info("Initializing provider manager...")
            self._provider_manager = ProviderManager()
            self._provider_manager.configure(
                use_free_providers=self._use_free_providers,
                google_api_key=google_api_key,
                ocr_provider=self._ocr_provider
            )
            provider_status = self._provider_manager.get_provider_status()
            logger.info(f"Provider manager initialized: {provider_status}")

            # Set confidence threshold
            saved_confidence = self._settings.get_setting("confidence_threshold")
            if saved_confidence is not None:
                logger.info(f"Using saved confidence threshold: {saved_confidence}")
                self._confidence_threshold = saved_confidence
            else:
                logger.info(f"No saved confidence threshold, using default: {self._confidence_threshold}")
                # Only save default if no setting exists
                self._settings.set_setting("confidence_threshold", self._confidence_threshold)

            # Set RapidOCR-specific confidence threshold
            saved_rapidocr_conf = self._settings.get_setting("rapidocr_confidence")
            if saved_rapidocr_conf is not None:
                logger.info(f"Using saved RapidOCR confidence: {saved_rapidocr_conf}")
                self._rapidocr_confidence = saved_rapidocr_conf
            else:
                logger.info(f"No saved RapidOCR confidence, using default: {self._rapidocr_confidence}")
                # Only save default if no setting exists
                self._settings.set_setting("rapidocr_confidence", self._rapidocr_confidence)
            # Apply RapidOCR confidence to provider manager
            if self._provider_manager:
                self._provider_manager.set_rapidocr_confidence(self._rapidocr_confidence)

            # Set RapidOCR box threshold
            saved_rapidocr_box = self._settings.get_setting("rapidocr_box_thresh")
            if saved_rapidocr_box is not None:
                logger.info(f"Using saved RapidOCR box_thresh: {saved_rapidocr_box}")
                self._rapidocr_box_thresh = saved_rapidocr_box
            else:
                logger.info(f"No saved RapidOCR box_thresh, using default: {self._rapidocr_box_thresh}")
                self._settings.set_setting("rapidocr_box_thresh", self._rapidocr_box_thresh)
            if self._provider_manager:
                self._provider_manager.set_rapidocr_box_thresh(self._rapidocr_box_thresh)

            # Set RapidOCR unclip ratio
            saved_rapidocr_unclip = self._settings.get_setting("rapidocr_unclip_ratio")
            if saved_rapidocr_unclip is not None:
                logger.info(f"Using saved RapidOCR unclip_ratio: {saved_rapidocr_unclip}")
                self._rapidocr_unclip_ratio = saved_rapidocr_unclip
            else:
                logger.info(f"No saved RapidOCR unclip_ratio, using default: {self._rapidocr_unclip_ratio}")
                self._settings.set_setting("rapidocr_unclip_ratio", self._rapidocr_unclip_ratio)
            if self._provider_manager:
                self._provider_manager.set_rapidocr_unclip_ratio(self._rapidocr_unclip_ratio)

            # Set pause game on overlay
            saved_pause_game = self._settings.get_setting("pause_game_on_overlay")
            if saved_pause_game is not None:
                logger.info(f"Using saved pause game on overlay: {saved_pause_game}")
                self._pause_game_on_overlay = saved_pause_game
            else:
                logger.info(f"No saved pause game on overlay, using default: {self._pause_game_on_overlay}")
                # Only save default if no setting exists
                self._settings.set_setting("pause_game_on_overlay", self._pause_game_on_overlay)

            # Set quick toggle enabled
            saved_quick_toggle = self._settings.get_setting("quick_toggle_enabled")
            if saved_quick_toggle is not None:
                logger.info(f"Using saved quick toggle enabled: {saved_quick_toggle}")
                self._quick_toggle_enabled = saved_quick_toggle
            else:
                logger.info(f"No saved quick toggle enabled, using default: {self._quick_toggle_enabled}")
                # Only save default if no setting exists
                self._settings.set_setting("quick_toggle_enabled", self._quick_toggle_enabled)

            logger.info(f"Config initialized successfully, using path: {self._screenshotPath}")

            # Start hidraw button monitor
            logger.info("Initializing hidraw button monitor...")
            self._hidraw_monitor = HidrawButtonMonitor()
            if self._hidraw_monitor.start():
                logger.info("Hidraw button monitor started successfully")
            else:
                logger.warning("Failed to start hidraw button monitor - button detection may not work")

        except Exception as e:
            logger.error(f"Error during initialization: {str(e)}")
            logger.error(traceback.format_exc())
        return

    async def _unload(self):
        logger.info("=== Unloading plugin ===")
        try:
            # Stop hidraw button monitor
            if self._hidraw_monitor:
                logger.info("Stopping hidraw button monitor...")
                self._hidraw_monitor.stop()
                self._hidraw_monitor = None
                logger.info("Hidraw button monitor stopped")

            # Close log files
            std_out_file.close()
            std_err_file.close()
            logger.info("Standard output log files closed")

            # Additional cleanup can go here
        except Exception as e:
            logger.error(f"Error during plugin unload: {str(e)}")
            logger.error(traceback.format_exc())
        return