# slide-station.sams.land (site/README.md). Built from the repository root, so the image can include
# the browser version of the app and the READMEs:
#
#   docker build -f site/Dockerfile -t slide-station-site .
#   docker run -p 8080:8080 -v site-data:/data slide-station-site
#
# The root .dockerignore is the Python container's; site/Dockerfile.dockerignore replaces it here.

# The browser version (README "In the browser"), served at /app
FROM node:24-slim AS app
WORKDIR /repo/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
COPY slidestation/models /repo/slidestation/models
RUN npm run build:web

# The docs, rendered from the READMEs
FROM node:24-slim AS docs
WORKDIR /repo/site
COPY site/package.json site/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY README.md /repo/
COPY desktop/README.md /repo/desktop/
COPY apple/README.md /repo/apple/
COPY site ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data APP_DIR=/srv/app NODE_NO_WARNINGS=1
WORKDIR /srv/site
COPY --from=docs /repo/site/*.mjs ./
COPY --from=docs /repo/site/public ./public
COPY --from=docs /repo/site/dist ./dist
COPY frontend/public /srv/frontend/public
COPY --from=app /repo/frontend/dist-web /srv/app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
