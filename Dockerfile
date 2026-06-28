FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    chromium \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Nightly channel — stable lags badly on YouTube's SABR streaming changes
# (yt-dlp#12482), which is what breaks section downloads. Bump YTDLP_BUST to
# force a fresh binary on rebuild (the cached layer can pin a broken one).
ARG YTDLP_BUST=2026-06-22b
RUN curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
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
