FROM node:20-alpine

RUN apk add --no-cache python3 ffmpeg yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p downloads frames

EXPOSE 8097

CMD ["node", "server.js"]
