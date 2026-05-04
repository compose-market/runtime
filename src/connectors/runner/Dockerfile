FROM node:24-slim

ENV NODE_ENV=production
ENV npm_config_yes=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g supergateway@3.4.3

WORKDIR /app
COPY fetch-defaults.cjs /app/fetch-defaults.cjs
COPY server.mjs /app/server.mjs
ENV COMPOSE_FETCH_PRELOAD=/app/fetch-defaults.cjs
ENV NODE_OPTIONS=--require=/app/fetch-defaults.cjs

EXPOSE 8080
CMD ["node", "/app/server.mjs"]
