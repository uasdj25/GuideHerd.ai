#!/bin/bash
# GuideHerd Legal Intake Copilot — Local Demo Startup
# Usage: ./start.sh

set -e
cd "$(dirname "$0")"

echo ""
echo "🏛️  GuideHerd Legal Intake Copilot"
echo "   ================================"
echo ""

# Check Python 3
if command -v python3 &>/dev/null; then
  echo "✅ Python 3 found: $(python3 --version)"
  echo ""
  echo "   Starting server at http://localhost:3001"
  echo "   Open your browser to: http://localhost:3001"
  echo ""
  echo "   Press Ctrl+C to stop."
  echo ""
  python3 server.py

elif command -v node &>/dev/null; then
  echo "✅ Node.js found: $(node --version)"
  echo "   Starting Node backend..."
  cd backend && npm install --silent && node server.js &
  BACKEND_PID=$!
  echo "   Backend PID: $BACKEND_PID"
  echo ""
  echo "   Starting React frontend..."
  cd ../frontend && npm install --silent && npm run dev
  kill $BACKEND_PID 2>/dev/null

else
  echo "❌ Neither Python 3 nor Node.js found."
  echo ""
  echo "   Install one of:"
  echo "   • Python 3: https://www.python.org/downloads/"
  echo "   • Node.js:  https://nodejs.org/"
  echo ""
  exit 1
fi
