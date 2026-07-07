FROM node:24-trixie-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-trixie-slim AS development

ENV NODE_ENV=development
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl=8.14.1-2+deb13u3 dumb-init=1.2.5-3 \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY vitest.config.ts ./
COPY .dockerignore ./

RUN mkdir -p /data \
	&& chown -R node:node /app /data

USER node

EXPOSE 3000
VOLUME ["/data"]

ENV DITTOBOT_STORE__TYPE=local
ENV DITTOBOT_STORE__PATH=/data

RUN npm run build
COPY app.yml ./app.yml

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD curl --fail http://localhost:3000/ping || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]


FROM node:24-trixie-slim AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl=8.14.1-2+deb13u3 dumb-init=1.2.5-3 \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
	&& npm cache clean --force

COPY --from=build /app/dist ./dist
COPY app.yml ./app.yml

RUN mkdir -p /data \
	&& chown -R node:node /app /data

USER node

EXPOSE 3000
VOLUME ["/data"]

ENV DITTOBOT_STORE__TYPE=local
ENV DITTOBOT_STORE__PATH=/data

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 CMD curl --fail http://localhost:3000/ping || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
