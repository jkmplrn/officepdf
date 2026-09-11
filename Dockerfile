FROM node:20-slim

# Install Ghostscript, poppler-utils (pdftoppm), and zip
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ghostscript \
    poppler-utils \
    zip \
    inkscape \
    pstoedit \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN apt-get update -qq && apt-get install -y -qq python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
