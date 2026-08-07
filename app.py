from flask import Flask, send_from_directory, jsonify
from datetime import datetime
import os

app = Flask(__name__, static_folder="static")


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


@app.route("/<path:filename>")
def root_assets(filename):
    """Serve static files from the root path.

    Production is a static host where everything sits at the root, so the page
    references /symptoms.css, /manifest.json, /icon.svg etc. without a prefix.
    This mirrors that layout for local dev. Registered last so the explicit
    routes above always win.
    """
    return send_from_directory("static", filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_ENV") != "production"
    app.run(debug=debug, host="0.0.0.0", port=port)
