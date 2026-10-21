# Hosted Stillwater Yoga (no secret part, no results). Start needs, at run time:
#   CODER_PARCOURS_TRUST_PROXY   number of reverse proxies in front (0 = direct)
#   CODER_PARCOURS_ADMIN_TOKEN   strong token, at least 32 characters (e.g. openssl rand -base64 32)
# Both are passed with `docker run -e`; nothing is generated or stored in the image.
# Mount a volume on /app/data, or the human reports are lost on every restart.
FROM node:22.14.0-slim
WORKDIR /app
ARG CODER_PARCOURS_COMMIT
ENV CODER_PARCOURS_COMMIT=${CODER_PARCOURS_COMMIT}
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 8080
CMD ["npm", "run", "start:hosted"]
