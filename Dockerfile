FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Prevent interactive prompts (tzdata)
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    xvfb fluxbox x11vnc novnc websockify \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000 7900
CMD ["bash", "start-vnc.sh"]
