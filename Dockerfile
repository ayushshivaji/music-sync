FROM node:22-alpine

RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY host ./host
COPY client ./client

ENV NODE_ENV=production
ENV PORT=7500

EXPOSE 7500

CMD ["npm", "start"]
