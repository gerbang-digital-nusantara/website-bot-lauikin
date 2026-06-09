# Lauk.In visitor web - production image
# Static website + tracking endpoint compatible with Netlify Function path.
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4099

COPY --from=deps /app/node_modules ./node_modules
COPY . .

EXPOSE 4099

CMD ["npm", "start"]
