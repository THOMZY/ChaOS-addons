FROM eclipse-temurin:17-jre-alpine

# Install wget for downloading JARs at runtime
RUN apk add --no-cache wget su-exec
RUN addgroup -S minecraft && adduser -S minecraft -G minecraft \
    && mkdir -p /server \
    && chown -R minecraft:minecraft /server

# Entrypoint script: downloads paper.jar + plugins on first run if missing,
# then starts the server. JARs are NOT baked into the image — they land in
# the bind-mounted ./minecraft folder and are visible on the host.
COPY entrypoint.sh /entrypoint.sh
COPY configure-rcon.sh /configure-rcon.sh
COPY default-server-icon.png /opt/minecraft/default-server-icon.png
# Strip Windows CRLF line endings in case the file was edited on Windows
RUN sed -i 's/\r$//' /entrypoint.sh /configure-rcon.sh && chmod +x /entrypoint.sh

WORKDIR /server
# Root is used only by the entrypoint to repair old root-owned bind mounts.
# The entrypoint immediately re-execs as minecraft before configuration or Java.

EXPOSE 25565

ENTRYPOINT ["/entrypoint.sh"]
