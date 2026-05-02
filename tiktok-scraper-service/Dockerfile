# Sử dụng image chính thức của Playwright (đã có sẵn Node.js và các trình duyệt)
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

# Tạo thư mục làm việc trong container
WORKDIR /app

# Copy package.json và package-lock.json trước để tận dụng cache của Docker
COPY package*.json ./

# Cài đặt dependencies
RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

# Mở cổng 3000 (cổng mà Express đang chạy)
EXPOSE 3000

# Lệnh khởi chạy ứng dụng
CMD ["node", "index.js"]