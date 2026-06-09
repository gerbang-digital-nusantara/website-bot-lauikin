# Lauk.In visitor web - production image
# App code only. Image assets are mounted from /home/app/laukin-images on VPS.
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4099

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4099

CMD ["npm", "start"]
