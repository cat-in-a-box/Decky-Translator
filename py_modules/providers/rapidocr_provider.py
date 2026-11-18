# providers/rapidocr_provider.py
# Local RapidOCR provider - runs entirely on device without internet
# Uses ONNX Runtime for fast inference with PaddleOCR models

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import List, Optional

from .base import OCRProvider, ProviderType, TextRegion
from . import python_runtime

logger = logging.getLogger(__name__)

# Default minimum confidence threshold (0.0-1.0 scale)
# Results below this confidence are filtered out
DEFAULT_MIN_CONFIDENCE = 0.5

# Fallback when no models_dir is provided (tests, older installs).
LEGACY_MODELS_DIR = "bin/rapidocr/models"

# OCR timeout in seconds (Steam Deck CPU can be slow)
OCR_TIMEOUT_SECONDS = 120

# Stripped from the worker's env so ONNX can use multiple threads. The
# oneshot path needs to cap threads to avoid deadlocks in the asyncio loop;
# the worker runs in its own process with no event loop, so it's fine.
_WORKER_ENV_STRIP = (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
)

_WORKER_THREADS = 4


class RapidOCRProvider(OCRProvider):
    """
    OCR provider using RapidOCR (PaddleOCR via ONNX Runtime).

    Runs on-device. Has two execution paths:
      - oneshot: spawn a short-lived subprocess per call (default)
      - persistent worker: keep a long-lived worker subprocess alive between
        calls. Opt-in via set_persistent_mode(True). Eliminates the
        per-request Python startup + model-load cost.
    """

    # Language code mapping: plugin codes -> model family identifiers
    # PP-OCRv5 has per-language-family recognition models
    LANGUAGE_MAP = {
        'auto': 'ch',
        'en': 'ch',         # ch model handles English well in mixed-script text
        'zh-CN': 'ch',
        'zh-TW': 'ch',
        'ja': 'ch',         # v5 ch model handles Japanese natively
        'ko': 'korean',
        'de': 'latin',
        'fr': 'latin',
        'es': 'latin',
        'it': 'latin',
        'pt': 'latin',
        'nl': 'latin',
        'no': 'latin',
        'pl': 'latin',
        'tr': 'latin',
        'ro': 'latin',
        'vi': 'latin',
        'fi': 'latin',
        'hr': 'latin',
        'cs': 'latin',
        'hu': 'latin',
        'sv': 'latin',
        'da': 'latin',
        'ru': 'eslav',
        'uk': 'eslav',
        'bg': 'eslav',
        'el': 'greek',
        'th': 'thai',
    }

    SUPPORTED_LANGUAGES = [
        'auto', 'en', 'zh-CN', 'zh-TW', 'ja', 'ko',
        'de', 'fr', 'es', 'it', 'pt', 'nl', 'no', 'pl', 'tr', 'ro', 'vi', 'fi',
        'hr', 'cs', 'hu', 'sv', 'da',
        'ru', 'uk', 'bg', 'el', 'th'
    ]

    def __init__(
        self,
        plugin_dir: str = "",
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
        models_dir: str = "",
    ):
        """
        Initialize the RapidOCR provider.

        Args:
            plugin_dir: Path to plugin directory. If empty, uses DECKY_PLUGIN_DIR
                        environment variable.
            min_confidence: Minimum confidence threshold (0.0-1.0) for filtering results.
            models_dir: Where the ONNX models live. ProviderManager passes the
                        downloader's target dir (settings dir based). Falls back
                        to the legacy bundled bin/rapidocr/models path so direct
                        instantiation in tests still works.
        """
        self._plugin_dir = plugin_dir or os.environ.get(
            "DECKY_PLUGIN_DIR",
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        )
        self._models_dir = models_dir or os.path.join(self._plugin_dir, LEGACY_MODELS_DIR)
        self._min_confidence = max(0.0, min(1.0, min_confidence))
        self._box_thresh = 0.5  # Detection box threshold
        self._unclip_ratio = 1.6  # Box expansion ratio
        self._init_error = None  # Store any initialization error
        self._python_path = None  # Path to system Python 3 interpreter
        self._logged_python_path: Optional[str] = None

        self._persistent_mode = False
        self._worker_proc: Optional[subprocess.Popen] = None
        self._worker_lock = threading.Lock()

        # Path to subprocess script
        # Check bin/py_modules first (Decky Store install via remote_binary)
        # Then fall back to root py_modules (dev/manual install)
        bin_subprocess_script = os.path.join(
            self._plugin_dir, "bin", "py_modules", "providers", "rapidocr_subprocess.py"
        )
        root_subprocess_script = os.path.join(
            self._plugin_dir, "py_modules", "providers", "rapidocr_subprocess.py"
        )
        if os.path.exists(bin_subprocess_script):
            self._subprocess_script = bin_subprocess_script
        else:
            self._subprocess_script = root_subprocess_script

        # Determine py_modules path(s) for subprocess PYTHONPATH
        # bin/py_modules first (cp313 pip packages from remote_binary)
        # root py_modules second (providers source code, always present)
        bin_py_modules = os.path.join(self._plugin_dir, "bin", "py_modules")
        root_py_modules = os.path.join(self._plugin_dir, "py_modules")
        py_paths = [p for p in [bin_py_modules, root_py_modules] if os.path.exists(p)]
        self._py_modules_dir = os.pathsep.join(py_paths) if py_paths else root_py_modules

        logger.debug(
            f"RapidOCRProvider initialized "
            f"(plugin_dir={self._plugin_dir}, min_confidence={min_confidence})"
        )

    def _check_availability(self) -> bool:
        """Check if RapidOCR subprocess script and models are available."""
        self._init_error = None  # Clear any previous error

        # Check if subprocess script exists
        if not os.path.exists(self._subprocess_script):
            self._init_error = f"RapidOCR subprocess script not found: {self._subprocess_script}"
            logger.warning(self._init_error)
            return False

        det_model = os.path.join(self._models_dir, "ch_PP-OCRv5_mobile_det.onnx")
        cls_model = os.path.join(self._models_dir, "ch_ppocr_mobile_v2.0_cls_infer.onnx")
        if not (os.path.exists(det_model) and os.path.exists(cls_model)):
            self._init_error = (
                "RapidOCR models not downloaded. Open the plugin settings, "
                "select the RapidOCR provider, and download the models."
            )
            logger.warning(self._init_error)
            return False

        # Find Python 3.13 interpreter (bundled, then system fallback)
        # Note: sys.executable points to PluginLoader, not a Python interpreter!
        # We must NOT use sys.executable as it would spawn another Decky instance
        self._python_path = python_runtime.find_python(self._plugin_dir)
        if not self._python_path:
            self._init_error = (
                "Python 3.13 runtime missing. Reinstall the plugin to restore "
                "the bundled runtime, or install python3.13 on your system."
            )
            logger.warning(self._init_error)
            return False

        if self._python_path != self._logged_python_path:
            logger.debug(f"RapidOCR: Using Python interpreter: {self._python_path}")
            self._logged_python_path = self._python_path
        return True

    @property
    def name(self) -> str:
        return "RapidOCR (Local)"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.RAPIDOCR

    def is_available(self, language: str = "auto") -> bool:
        """
        Check if RapidOCR is available for the given language.

        Args:
            language: Language code to check

        Returns:
            True if RapidOCR can handle this language
        """
        # Re-check every call so a fresh model download flips us back to available.
        if not self._check_availability():
            return False
        return language in self.SUPPORTED_LANGUAGES

    def get_supported_languages(self) -> List[str]:
        """Return list of supported language codes."""
        return self.SUPPORTED_LANGUAGES.copy()

    def set_min_confidence(self, confidence: float) -> None:
        """
        Set the minimum confidence threshold for filtering OCR results.

        Args:
            confidence: Minimum confidence (0.0-1.0) to accept results.
                        Lower values = more results but more noise.
                        Higher values = fewer results but more accurate.
        """
        value = max(0.0, min(1.0, confidence))
        if value == self._min_confidence:
            return
        self._min_confidence = value
        logger.debug(f"RapidOCRProvider min_confidence set to {value}")
        self._restart_worker_if_running()

    def set_box_thresh(self, box_thresh: float) -> None:
        """
        Set the detection box threshold.

        Args:
            box_thresh: Detection box confidence (0.0-1.0).
                        Lower values = more text boxes detected.
                        Higher values = fewer but more confident boxes.
        """
        value = max(0.0, min(1.0, box_thresh))
        if value == self._box_thresh:
            return
        self._box_thresh = value
        logger.debug(f"RapidOCRProvider box_thresh set to {value}")
        self._restart_worker_if_running()

    def set_unclip_ratio(self, unclip_ratio: float) -> None:
        """
        Set the box expansion ratio.

        Args:
            unclip_ratio: Ratio for expanding detected boxes (1.0-3.0).
                          Higher values = larger text regions.
        """
        value = max(1.0, min(3.0, unclip_ratio))
        if value == self._unclip_ratio:
            return
        self._unclip_ratio = value
        logger.debug(f"RapidOCRProvider unclip_ratio set to {value}")
        self._restart_worker_if_running()

    def set_persistent_mode(self, enabled: bool) -> None:
        enabled = bool(enabled)
        if enabled == self._persistent_mode:
            return
        self._persistent_mode = enabled
        logger.info(f"RapidOCR persistent mode: {enabled}")
        if enabled:
            # Warm up off the caller's thread so the first translate is fast.
            threading.Thread(target=self._warmup_worker, daemon=True).start()
        else:
            self.stop_worker()

    def _warmup_worker(self) -> None:
        if self._persistent_mode:
            self.start_worker()

    def get_init_error(self) -> Optional[str]:
        """Return any initialization error message."""
        return self._init_error

    def get_rapidocr_info(self) -> dict:
        """
        Get RapidOCR version and installation info.

        Returns:
            Dictionary with version, availability, model info, etc.
        """
        info = {
            "available": False,
            "version": None,
            "models_dir": self._models_dir,
            "bundled_models": False,
            "min_confidence": self._min_confidence,
            "error": self._init_error,
            "mode": "subprocess",
            "persistent_mode": self._persistent_mode,
            "worker_alive": self._is_worker_alive(),
        }

        info["available"] = self._check_availability()

        # Get RapidOCR version from package metadata (no import needed)
        # Check both locations: bin/py_modules (store install) and py_modules (dev install)
        try:
            py_modules_paths = [
                os.path.join(self._plugin_dir, 'bin', 'py_modules'),  # Store install
                os.path.join(self._plugin_dir, 'py_modules'),         # Dev install
            ]
            for py_modules in py_modules_paths:
                if not os.path.exists(py_modules):
                    continue
                # Look for rapidocr-*.dist-info/METADATA
                for item in os.listdir(py_modules):
                    if item.startswith('rapidocr-') and item.endswith('.dist-info'):
                        metadata_file = os.path.join(py_modules, item, 'METADATA')
                        if os.path.exists(metadata_file):
                            with open(metadata_file, 'r') as f:
                                for line in f:
                                    if line.startswith('Version:'):
                                        info["version"] = line.split(':', 1)[1].strip()
                                        break
                        break
                if info["version"]:
                    break
        except Exception:
            pass

        # Check for bundled models
        if os.path.exists(self._models_dir):
            det_model = os.path.join(self._models_dir, "ch_PP-OCRv5_mobile_det.onnx")
            info["bundled_models"] = os.path.exists(det_model)
        return info

    def _is_worker_alive(self) -> bool:
        proc = self._worker_proc
        return proc is not None and proc.poll() is None

    def _start_stderr_drainer(self, proc: subprocess.Popen) -> None:
        def drain():
            try:
                stream = proc.stderr
                if stream is None:
                    return
                for raw in iter(stream.readline, b''):
                    if not raw:
                        break
                    try:
                        line = raw.decode('utf-8', errors='replace').rstrip()
                    except Exception:
                        continue
                    if line:
                        logger.warning(f"RapidOCR worker stderr: {line}")
            except Exception:
                pass

        t = threading.Thread(target=drain, daemon=True)
        t.start()

    def _build_worker_env(self) -> dict:
        env = os.environ.copy()
        env['PYTHONPATH'] = self._py_modules_dir
        env['PYTHONNOUSERSITE'] = '1'
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        for k in _WORKER_ENV_STRIP:
            env.pop(k, None)
        return env

    def start_worker(self) -> bool:
        """Start the worker subprocess and wait for ready"""
        with self._worker_lock:
            if not self._persistent_mode:
                return False
            if self._worker_proc is not None and self._worker_proc.poll() is None:
                return True

            if not self._check_availability() or not self._python_path:
                logger.warning("Cannot start RapidOCR worker: provider not available")
                return False

            env = self._build_worker_env()
            try:
                self._worker_proc = subprocess.Popen(
                    [self._python_path, '-S', self._subprocess_script, '--worker'],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=env,
                )
            except Exception as e:
                logger.error(f"Failed to spawn RapidOCR worker: {e}")
                self._worker_proc = None
                return False

            # Without this the ~64 KB stderr pipe eventually fills up from
            # ONNX warnings and the worker blocks, deadlocking our stdout read.
            self._start_stderr_drainer(self._worker_proc)

            init_msg = {
                "type": "init",
                "models_dir": self._models_dir,
                "min_confidence": self._min_confidence,
                "box_thresh": self._box_thresh,
                "unclip_ratio": self._unclip_ratio,
                "lang_family": "ch",
                "threads": _WORKER_THREADS,
            }
            start = time.time()
            try:
                self._worker_proc.stdin.write((json.dumps(init_msg) + "\n").encode())
                self._worker_proc.stdin.flush()
                ready_line = self._worker_proc.stdout.readline()
                if not ready_line:
                    logger.error("RapidOCR worker died before ready response")
                    self._kill_worker_unlocked()
                    return False
                ready = json.loads(ready_line.decode().strip())
                if ready.get("error"):
                    logger.error(f"RapidOCR worker init error: {ready['error']}")
                    self._kill_worker_unlocked()
                    return False
            except Exception as e:
                logger.error(f"RapidOCR worker init failed: {e}")
                self._kill_worker_unlocked()
                return False

            elapsed = time.time() - start
            logger.info(f"RapidOCR worker ready ({elapsed:.2f}s)")
            return True

    def stop_worker(self) -> None:
        with self._worker_lock:
            self._kill_worker_unlocked()

    def _kill_worker_unlocked(self) -> None:
        proc = self._worker_proc
        self._worker_proc = None
        if proc is None:
            return
        try:
            if proc.poll() is None:
                try:
                    proc.stdin.write(b'{"type":"shutdown"}\n')
                    proc.stdin.flush()
                except Exception:
                    pass
                try:
                    proc.stdin.close()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.terminate()
                    try:
                        proc.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        try:
                            proc.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            pass
        except Exception as e:
            logger.warning(f"Error stopping RapidOCR worker: {e}")
        for f in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if f:
                    f.close()
            except Exception:
                pass
        logger.debug("RapidOCR worker stopped")

    def _restart_worker_if_running(self) -> None:
        if not self._persistent_mode:
            return
        if not self._is_worker_alive():
            return
        logger.debug("RapidOCR settings changed, restarting worker")
        self.stop_worker()
        threading.Thread(target=self._warmup_worker, daemon=True).start()

    async def recognize(self, image_data: bytes, language: str = "auto") -> List[TextRegion]:
        if not self._check_availability():
            logger.error("RapidOCR is not available")
            return []

        if self._persistent_mode:
            result = self._recognize_via_worker(image_data, language)
            if result is not None:
                return result
            logger.warning("RapidOCR worker unavailable, falling back to oneshot")

        return self._recognize_oneshot(image_data, language)

    def _recognize_via_worker(self, image_data: bytes, language: str) -> Optional[List[TextRegion]]:
        if not self._is_worker_alive():
            if not self.start_worker():
                return None

        temp_path = os.path.join(
            tempfile.gettempdir(),
            f"rapidocr_input_{os.getpid()}.png"
        )
        try:
            with open(temp_path, 'wb') as f:
                f.write(image_data)

            lang_family = self.LANGUAGE_MAP.get(language, 'ch')
            request = {
                "type": "recognize",
                "image_path": temp_path,
                "lang_family": lang_family,
            }

            start = time.time()
            with self._worker_lock:
                if self._worker_proc is None or self._worker_proc.poll() is not None:
                    logger.warning("RapidOCR worker not running during request")
                    return None
                try:
                    self._worker_proc.stdin.write((json.dumps(request) + "\n").encode())
                    self._worker_proc.stdin.flush()
                    response_line = self._worker_proc.stdout.readline()
                except Exception as e:
                    logger.error(f"RapidOCR worker I/O error: {e}")
                    self._kill_worker_unlocked()
                    return None

                if not response_line:
                    logger.error("RapidOCR worker: empty response (died)")
                    self._kill_worker_unlocked()
                    return None

                try:
                    response = json.loads(response_line.decode().strip())
                except json.JSONDecodeError as e:
                    logger.error(f"RapidOCR worker: bad JSON response: {e}")
                    return None

            elapsed = time.time() - start
            if response.get("error"):
                logger.error(f"RapidOCR worker error: {response['error']}")
                return []

            text_regions = []
            for region in response.get("regions", []):
                text_regions.append(TextRegion(
                    text=region["text"],
                    rect=region["rect"],
                    confidence=region["confidence"],
                    is_dialog=region.get("is_dialog", False),
                ))
            logger.debug(f"RapidOCR (worker): {len(text_regions)} regions in {elapsed:.2f}s")
            return text_regions
        finally:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except Exception:
                pass

    def _recognize_oneshot(self, image_data: bytes, language: str) -> List[TextRegion]:
        temp_image_path = None
        try:
            start_time = time.time()
            logger.debug("RapidOCR: Starting oneshot subprocess OCR...")

            # Save image to temp file
            temp_image_path = os.path.join(
                tempfile.gettempdir(),
                f"rapidocr_input_{os.getpid()}.png"
            )
            with open(temp_image_path, 'wb') as f:
                f.write(image_data)

            # Build environment with py_modules as ONLY Python path
            # This ensures we use our bundled packages, not the standalone Python's
            env = os.environ.copy()
            # Use detected py_modules path (bin/py_modules for store, root for dev)
            env['PYTHONPATH'] = self._py_modules_dir
            # Disable user site-packages
            env['PYTHONNOUSERSITE'] = '1'
            # Ensure isolated mode-like behavior
            env['PYTHONDONTWRITEBYTECODE'] = '1'
            # Set threading environment variables
            env['OMP_NUM_THREADS'] = '1'
            env['MKL_NUM_THREADS'] = '1'
            env['OPENBLAS_NUM_THREADS'] = '1'

            # Run subprocess using system Python 3 (NOT sys.executable which is PluginLoader!)
            if not self._python_path:
                logger.error("RapidOCR: No Python interpreter available")
                return []

            lang_family = self.LANGUAGE_MAP.get(language, 'ch')

            cmd = [
                self._python_path,
                '-S',  # Ignore site-packages from standalone Python
                self._subprocess_script,
                temp_image_path,
                self._models_dir,
                str(self._min_confidence),
                str(self._box_thresh),
                str(self._unclip_ratio),
                lang_family,
            ]
            logger.debug(f"RapidOCR: Running subprocess: {' '.join(cmd)}")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=OCR_TIMEOUT_SECONDS,
                env=env,
            )

            elapsed = time.time() - start_time
            logger.debug(f"RapidOCR: Subprocess completed in {elapsed:.2f}s")

            if result.returncode != 0:
                logger.error(f"RapidOCR: Subprocess error: {result.stderr}")
                return []

            # Parse JSON output
            try:
                output = json.loads(result.stdout)
            except json.JSONDecodeError as e:
                logger.error(f"RapidOCR: Failed to parse output: {e}")
                logger.error(f"RapidOCR: stdout: {result.stdout[:500]}")
                return []

            # Log debug info if present
            if output.get("debug"):
                for dbg in output["debug"]:
                    logger.debug(f"RapidOCR subprocess: {dbg}")

            if output.get("error"):
                logger.error(f"RapidOCR: OCR error: {output['error']}")
                return []

            # Convert to TextRegion objects
            text_regions = []
            for region in output.get("regions", []):
                text_regions.append(TextRegion(
                    text=region["text"],
                    rect=region["rect"],
                    confidence=region["confidence"],
                    is_dialog=region.get("is_dialog", False),
                ))

            logger.debug(f"RapidOCR: Found {len(text_regions)} text regions in {elapsed:.2f}s")
            return text_regions

        except subprocess.TimeoutExpired:
            logger.error(f"RapidOCR: Subprocess timed out after {OCR_TIMEOUT_SECONDS}s")
            return []
        except Exception as e:
            logger.error(f"RapidOCR OCR error: {e}", exc_info=True)
            return []
        finally:
            # Clean up temp file
            if temp_image_path and os.path.exists(temp_image_path):
                try:
                    os.remove(temp_image_path)
                except Exception:
                    pass
