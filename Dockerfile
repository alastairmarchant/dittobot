FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-bookworm-slim AS development

ENV NODE_ENV=development
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends dumb-init \
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

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]


FROM node:24-bookworm-slim AS production

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends dumb-init \
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

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
