import time
from datetime import datetime
from typing import List, Dict, Any, Optional
from collections import deque
import threading

_lock = threading.Lock()
_LOG_BUFFER = deque(maxlen=500)
_LOG_COUNTER = 0

def log_event(category: str, message: str, details: Optional[Dict[str, Any]] = None, level: str = "INFO") -> Dict[str, Any]:
    global _LOG_COUNTER
    with _lock:
        _LOG_COUNTER += 1
        now = datetime.now()
        timestamp_str = now.strftime("%H:%M:%S") + f".{now.microsecond // 1000:03d}"
        entry = {
            "id": _LOG_COUNTER,
            "timestamp": timestamp_str,
            "category": category.upper(),
            "message": message,
            "level": level.upper(),
            "details": details or {}
        }
        _LOG_BUFFER.append(entry)
        return entry

def get_logs(since_id: int = 0) -> List[Dict[str, Any]]:
    with _lock:
        if since_id <= 0:
            return list(_LOG_BUFFER)
        return [entry for entry in _LOG_BUFFER if entry["id"] > since_id]

def clear_logs():
    global _LOG_COUNTER
    with _lock:
        _LOG_BUFFER.clear()
        _LOG_COUNTER = 0
