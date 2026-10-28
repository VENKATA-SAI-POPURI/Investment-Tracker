"""Entry point: `gunicorn app:app` (Render) or `python app.py` (local dev on :5002)."""
from tracker import create_app

app = create_app()

if __name__ == "__main__":
    app.run(debug=True, port=5002, host="0.0.0.0", use_reloader=False)
