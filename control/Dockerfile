# Stdlib-only Python service — no requirements install, tiny image.
# Owns the same-origin /api/state + /api/map endpoints that make map switches
# reliable: one in-flight RCON changelevel, A2S_INFO confirmation, and a map
# state every connected browser page can poll. See control/server.py.
FROM python:3.12-alpine

WORKDIR /srv
COPY server.py /srv/server.py

# Runs as an unprivileged user; the container only needs outbound UDP to the
# game server and its own HTTP port inside the compose network.
RUN adduser -D -H -u 10001 control
USER control

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["python", "/srv/server.py"]
