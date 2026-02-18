FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Virtual display + VNC + noVNC
RUN apt-get update && apt-get install -y \
    xvfb fluxbox x11vnc novnc websockify \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for caching
COPY package*.json ./
RUN npm install

# Copy the rest of your project
COPY . .

# Expose:
# 3000 = your UI
# 7900 = noVNC in browser
EXPOSE 3000 7900

CMD ["bash", "start-vnc.sh"]
