FROM node:20-slim

# Install system tools
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ghostscript \
    poppler-utils \
    zip \
    inkscape \
    pstoedit \
    python3 \
    python3-pip \
    python3-venv \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Python PDF libraries in a virtual environment
RUN python3 -m venv /opt/pdfvenv && \
    /opt/pdfvenv/bin/pip install --no-cache-dir \
    pypdf \
    pikepdf

# Make venv python accessible
ENV PATH="/opt/pdfvenv/bin:$PATH"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
