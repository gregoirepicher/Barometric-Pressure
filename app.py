from flask import Flask, request, jsonify, send_from_directory
import requests
from datetime import datetime, timedelta
import time
import logging
import json
import os

app = Flask(__name__, static_folder="static")
logging.basicConfig(level=logging.INFO)

# --- File-backed cache ---
# Survives Render restarts so we don't hammer Open-Meteo on every cold start.
CACHE_TTL = 3600       # 1 hour — plenty fresh for hourly pressure data
CACHE_FILE = "/tmp/bp_cache.json"

def _load_cache():
    try:
        with open(CACHE_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}

def _save_cache(cache):
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f)
    except Exception as e:
        logging.warning(f"Could not save cache: {e}")

def cache_get(key):
    cache = _load_cache()
    entry = cache.get(key)
    if entry and time.time() - entry["ts"] < CACHE_TTL:
        return entry["data"]
    return None

def cache_set(key, data):
    cache = _load_cache()
    cache[key] = {"data": data, "ts": time.time()}
    # Evict entries older than 3x TTL
    now = time.time()
    cache = {k: v for k, v in cache.items() if now - v["ts"] < CACHE_TTL * 3}
    _save_cache(cache)

def cache_get_stale(key):
    """Return cached data regardless of age — used as last resort fallback."""
    cache = _load_cache()
    entry = cache.get(key)
    return entry["data"] if entry else None


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/sw.js")
def service_worker():
    """Serve SW from root so it can control the whole origin."""
    return send_from_directory("static", "sw.js", mimetype="application/javascript")


@app.route("/health")
def health():
    """Health check endpoint for uptime monitors."""
    return jsonify({"status": "ok", "timestamp": datetime.utcnow().isoformat()})


@app.route("/api/pressure")
def get_pressure():
    lat = request.args.get("lat", 43.6532, type=float)
    lon = request.args.get("lon", -79.3832, type=float)
    days_back = request.args.get("days_back", 3, type=int)
    days_forward = request.args.get("days_forward", 3, type=int)

    # Clamp ranges — Open-Meteo free tier supports up to 7 days forecast
    days_back = min(max(days_back, 1), 10)
    days_forward = min(max(days_forward, 1), 7)

    # Round coordinates to 2 decimal places for cache key consistency
    cache_key = f"pressure:{round(lat,2)}:{round(lon,2)}:{days_back}:{days_forward}"
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "surface_pressure",
        "past_days": days_back,
        "forecast_days": days_forward + 1,
        "timezone": "auto",
    }

    # Try once — if rate-limited or failed, serve stale cache immediately
    # (no sleeping inside a request handler — that blocks gunicorn)
    try:
        resp = requests.get(url, params=params, timeout=8)
        if resp.status_code == 429:
            logging.warning("Rate limited by Open-Meteo (429)")
            stale = cache_get_stale(cache_key)
            if stale:
                return jsonify(stale)
            return jsonify({"error": "Rate limited. Please try again in a few minutes."}), 429
        resp.raise_for_status()
        data = resp.json()

        hourly = data.get("hourly", {})
        result = {
            "times": hourly.get("time", []),
            "pressures": hourly.get("surface_pressure", []),
            "timezone": data.get("timezone", "UTC"),
            "latitude": data.get("latitude"),
            "longitude": data.get("longitude"),
            "elevation": data.get("elevation"),
        }
        cache_set(cache_key, result)
        return jsonify(result)
    except Exception as e:
        logging.warning(f"Open-Meteo request failed: {e}")
        stale = cache_get_stale(cache_key)
        if stale:
            logging.info("Serving stale cache after API failure")
            return jsonify(stale)
        return jsonify({"error": str(e)}), 502


@app.route("/api/geocode")
def geocode():
    """Search for cities using Open-Meteo geocoding API."""
    name = request.args.get("name", "")
    if len(name) < 2:
        return jsonify({"results": []})

    cache_key = f"geo:{name.lower()}"
    cached = cache_get(cache_key)
    if cached:
        return jsonify(cached)

    url = "https://geocoding-api.open-meteo.com/v1/search"
    params = {"name": name, "count": 10, "language": "en", "format": "json"}

    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logging.warning(f"Geocode API failed: {e}")
        return jsonify({"results": []})

    results = []
    for r in data.get("results", []):
        results.append({
            "name": r.get("name"),
            "country": r.get("country", ""),
            "admin1": r.get("admin1", ""),
            "latitude": r.get("latitude"),
            "longitude": r.get("longitude"),
        })
    response = {"results": results}
    cache_set(cache_key, response)
    return jsonify(response)


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    app.run(debug=debug, host="0.0.0.0", port=port)
