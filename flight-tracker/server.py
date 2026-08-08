#!/usr/bin/env python3
"""
Local "live planes overhead" demo server (pure software, stdlib only).
Serves the static flight-tracker app AND proxies the OpenSky Network
free API (which blocks browser CORS), so the whole thing runs locally
with zero dependencies and zero hardware.

Run:
    python3 server.py
Then open http://localhost:8777  (or the IP of this machine for the kids' tablet)
"""
import json
import math
import os
import urllib.parse
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler

# ---- defaults (override via query params on /api/states?lat=&lon=&radius=) ----
DEFAULT_HOME = {"lat": 35.78, "lon": -78.64}   # Wake County, NC (Andrew's area)
DEFAULT_RADIUS_KM = 60.0                        # show planes within ~60 km of home
OPENSKY = "https://opensky-network.org/api/states/all"
PORT = 8777
FOLDER = os.path.dirname(os.path.abspath(__file__))


def bbox(lat, lon, radius_km):
    """Return (lamin, lomin, lamax, lomax) for a circle of given radius around a point."""
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.2, abs(math.cos(math.radians(lat)))))
    return round(lat - dlat, 4), round(lon - dlon, 4), round(lat + dlat, 4), round(lon + dlon, 4)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FOLDER, **kwargs)

    def log_message(self, format, *args):  # keep the console quiet
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/states":
            try:
                lat = float(qs.get("lat", [DEFAULT_HOME["lat"]])[0])
                lon = float(qs.get("lon", [DEFAULT_HOME["lon"]])[0])
                radius = float(qs.get("radius", [DEFAULT_RADIUS_KM])[0])
            except ValueError:
                self.send_json({"error": "bad lat/lon/radius"}, status=400)
                return
            lamin, lomin, lamax, lomax = bbox(lat, lon, radius)
            url = OPENSKY + "?" + urllib.parse.urlencode({
                "lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax,
            })
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "flight-tracker-demo/1.0"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.load(resp)
                self.send_json({"time": data.get("time"), "states": data.get("states") or []})
            except Exception as e:  # network / rate limit
                self.send_json({"error": str(e)}, status=502)
            return

        if parsed.path == "/api/home":
            self.send_json({
                "lat": qs.get("lat", [DEFAULT_HOME["lat"]])[0],
                "lon": qs.get("lon", [DEFAULT_HOME["lon"]])[0],
                "radius_km": qs.get("radius", [DEFAULT_RADIUS_KM])[0],
            })
            return

        super().do_GET()


if __name__ == "__main__":
    print(f"\n  Live flight demo @ http://localhost:{PORT}  (Ctrl+C to stop)\n")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
