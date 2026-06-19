FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install openai-whisper --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install

WORKDIR /app
COPY . .

EXPOSE 3000

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "server.js"]