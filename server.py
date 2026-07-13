import http.server
import json
import os

PORT = 8000

class GridironServer(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Inject CORS headers so content scripts / bookmarklets on espn.com can POST here
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == '/sync':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                
                # Parse JSON to validate
                league_data = json.loads(post_data.decode('utf-8'))
                
                # Save data to a local file
                sync_file_path = os.path.join(os.getcwd(), 'imported_league.json')
                with open(sync_file_path, 'w', encoding='utf-8') as f:
                    json.dump(league_data, f, indent=2)
                
                print(f"[Sync Server] Successfully imported ESPN league data and saved to {sync_file_path}")

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "League synchronized locally!"}).encode('utf-8'))
            except Exception as e:
                print(f"[Sync Server] Error processing sync POST: {e}")
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()

import socketserver

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    print(f"============================================================")
    print(f" Gridiron Edge local development server running on port {PORT}")
    print(f" URL: http://localhost:{PORT}")
    print(f"============================================================")
    
    server_address = ('', PORT)
    httpd = ThreadingHTTPServer(server_address, GridironServer)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Gridiron Edge server.")
        httpd.server_close()
