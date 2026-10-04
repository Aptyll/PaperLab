#!/bin/sh
# Starts Paper Lab on a Mac and opens the page. Live data stays off until you
# press the button on the page. Nothing is added to login items or startup.
# Quit from the page (the dot, top right) when you're done.

cd "$(dirname "$0")" || exit 1
# The download keeps this file at the top of the Paper Lab folder; in the repo it lives in launcher/mac.
[ -f src/main.js ] || cd ../.. || exit 1
URL="http://localhost:4317/"

if curl -fs -o /dev/null "${URL}api/status"; then
  open "$URL"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Paper Lab needs Node. Install the LTS version from https://nodejs.org, then open this file again."
  open "https://nodejs.org"
  exit 1
fi

mkdir -p data
nohup node --disable-warning=ExperimentalWarning src/main.js --paused >> data/paper-lab.log 2>&1 &
i=0
while [ $i -lt 40 ]; do
  sleep 0.5
  if curl -fs -o /dev/null "${URL}api/status"; then
    open "$URL"
    echo "Paper Lab is running. You can close this window."
    exit 0
  fi
  i=$((i + 1))
done
echo "Paper Lab didn't start. The details are in data/paper-lab.log inside the Paper Lab folder."
exit 1
