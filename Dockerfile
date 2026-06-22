FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    chromium \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Bump YTDLP_BUST to force a fresh yt-dlp on rebuild — the cached layer can pin a
# weeks-old binary that current YouTube breaks. (YouTube changes constantly.)
ARG YTDLP_BUST=2026-06-22
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "server.js"]
