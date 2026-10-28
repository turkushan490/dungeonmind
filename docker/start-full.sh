#!/bin/sh
# :full image: start Chatterbox next to DungeonMind (only when the admin picks it, or TTS_ENGINE=chatterbox).
mkdir -p /data/voices
if [ "${CHATTERBOX:-on}" != "off" ]; then
  /opt/chatterbox/bin/python /app/docker/chatterbox_server.py &
fi
exec node --disable-warning=ExperimentalWarning server/dist/main.js
