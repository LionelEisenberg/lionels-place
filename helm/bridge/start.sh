#!/bin/bash
cd "$(dirname "$0")"
pip install -q -r requirements.txt
exec uvicorn app:app --host 0.0.0.0 --port 8002
