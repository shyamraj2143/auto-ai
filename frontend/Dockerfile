FROM node:22-alpine AS build

WORKDIR /app
COPY frontend/package*.json ./
RUN npm install

COPY frontend ./
ARG VITE_API_URL=https://auto-ai-app-download.up.railway.app/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Support Railway's healthcheck/service port plus the conventional HTTP port.
EXPOSE 80 8080

CMD ["nginx", "-g", "daemon off;"]
