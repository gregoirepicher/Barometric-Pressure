from flask import Flask, request, jsonify, send_from_directory
import requests
from datetime import datetime, timedelta

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/sw.js")
def service_worker():
    """Serve SW from root so it can control the whole origin."""
    return send_from_directory("static", "sw.js", mimetype="application/javascript")


@app.route("/api/pressure")
def get_pressure():
    lat = request.args.get("lat", 43.6532, type=float)
    lon = request.args.get("lon", -79.3832, type=float)
    days_back = request.args.get("days_back", 3, type=int)
    days_forward = request.args.get("days_forward", 3, type=int)

    days_back = min(max(days_back, 1), 10)
    days_forward = min(max(days_forward, 1), 10)

    today = datetime.utcnow().date()
    start_date = today - timedelta(days=days_back)
    end_date = today + timedelta(days=days_forward)

    # Open-Meteo: historical/current + forecast in one call
    # Use forecast API which includes past days
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "hourly": "surface_pressure",
        "past_days": days_back,
        "forecast_days": days_forward + 1,  # +1 to include today
        "timezone": "auto",
    }

    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    hourly = data.get("hourly", {})
    times = hourly.get("time", [])
    pressures = hourly.get("surface_pressure", [])

    # Build response with timezone info
    result = {
        "times": times,
        "pressures": pressures,
        "timezone": data.get("timezone", "UTC"),
        "latitude": data.get("latitude"),
        "longitude": data.get("longitude"),
        "elevation": data.get("elevation"),
    }
    return jsonify(result)


@app.route("/api/geocode")
def geocode():
    """Search for cities using Open-Meteo geocoding API."""
    name = request.args.get("name", "")
    if len(name) < 2:
        return jsonify({"results": []})

    url = "https://geocoding-api.open-meteo.com/v1/search"
    params = {"name": name, "count": 10, "language": "en", "format": "json"}

    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    results = []
    for r in data.get("results", []):
        results.append({
            "name": r.get("name"),
            "country": r.get("country", ""),
            "admin1": r.get("admin1", ""),
            "latitude": r.get("latitude"),
            "longitude": r.get("longitude"),
        })
    return jsonify({"results": results})


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    app.run(debug=debug, host="0.0.0.0", port=port)
