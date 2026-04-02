from flask import Flask, request, jsonify, send_from_directory
import requests
from datetime import datetime, timedelta
import time
import logging

app = Flask(__name__, static_folder="static")
logging.basicConfig(level=logging.INFO)

# --- Simple in-memory cache ---
# Caches Open-Meteo responses for 10 minutes to avoid hammering the API
# and to serve data quickly even if Open-Meteo has a brief hiccup.
_cache = {}
CACHE_TTL = 1800  # 30 minutes — pressure data doesn't change that fast


def cache_get(key):
    entry = _cache.get(key)
    if entry and time.time() - entry["ts"] < CACHE_TTL:
        return entry["data"]
    return None


def cache_set(key, data):
    _cache[key] = {"data": data, "ts": time.time()}
    # Evict old entries to prevent unbounded growth
    now = time.time()
    stale = [k for k, v in _cache.items() if now - v["ts"] > CACHE_TTL * 3]
    for k in stale:
        del _cache[k]


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

    # Retry up to 2 times with increasing timeout, respect 429 backoff
    last_error = None
    for attempt in range(3):
        try:
            timeout = 10 + attempt * 5  # 10s, 15s, 20s
            resp = requests.get(url, params=params, timeout=timeout)
            if resp.status_code == 429:
                wait = min(5 * (attempt + 1), 15)
                logging.warning(f"Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
                continue
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
            last_error = e
            logging.warning(f"Open-Meteo attempt {attempt + 1} failed: {e}")
            if attempt < 2:
                time.sleep(1)

    # All retries failed — return stale cache if available
    stale = _cache.get(cache_key)
    if stale:
        logging.info("Serving stale cache after API failure")
        return jsonify(stale["data"])

    # No cache at all — return error
    return jsonify({"error": str(last_error)}), 502


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
