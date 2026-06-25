FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-dejavu-core \
    chromium \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/SamurAIGPT/AI-Youtube-Shorts-Generator /app/shorts-generator
RUN cd /app/shorts-generator && pip3 install --break-system-packages -r requirements-local.txt

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
CMD ["node", "server.js"]
