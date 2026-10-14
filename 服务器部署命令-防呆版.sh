# ============================================================
#  Movie Room 服务器一键部署脚本（小白防呆版）
#  使用方法：登录阿里云网页终端后，逐段复制粘贴执行
#  每段下面都有「成功标志」，照着核对即可
# ============================================================


# ---------- 第 1 步：安装基础环境 ----------
# 把下面整段复制粘贴，回车执行（会询问 Y/n，直接回车默认 Y）

sudo apt update
sudo apt install -y git curl build-essential

# ✅ 成功标志：命令跑完回到绿色/白色命令行提示符，没有红色 error


# ---------- 第 2 步：安装 Node.js ----------

curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证（看到版本号就成功）：
node -v
npm -v
# ✅ 成功标志：分别输出 v20.x 和 10.x 之类的版本号


# ---------- 第 3 步：安装 PM2（进程守护） ----------

sudo npm install -g pm2

# ✅ 成功标志：跑完无报错，回到命令行提示符


# ---------- 第 4 步：拉取代码 ----------
# 把下面的仓库地址换成你自己的（去掉注释才能用）

cd /opt
sudo git clone https://github.com/zhaosiyan521-maker/movie-room1.0.git movie-room
cd movie-room

# 如果你的仓库是「私有」的，需要用带令牌的地址：
# sudo git clone https://<你的用户名>:<你的令牌>@github.com/zhaosiyan521-maker/movie-room1.0.git movie-room

# ✅ 成功标志：看到 "done." 和一堆文件列表，然后 cd 成功不报错


# ---------- 第 5 步：安装项目依赖 ----------

cd /opt/movie-room
npm install

# ✅ 成功标志：跑完没有 EBADPLATFORM 或 error，最后出现 "added NNN packages"


# ---------- 第 6 步：生成随机 JWT 密钥 ----------

openssl rand -hex 32
# ✅ 复制这行输出的 64 位字符串，第 8 步要用


# ---------- 第 7 步：创建配置文件 .env ----------

cd /opt/movie-room/server
cat > .env << 'EOF'
DATABASE_URL="file:./dev.db"
JWT_SECRET="把第6步的64位随机字符串粘贴到这里"
PORT=3001
HOST="0.0.0.0"
# 可信反向代理：直连 3001 填 0；用 Nginx 反代填 1（配错会破坏限流与封禁，见部署文档 10.1）
TRUST_PROXY="0"
CLIENT_URL="http://你的公网IP,http://localhost:3001"
SMTP_HOST="smtp.qq.com"
SMTP_PORT="465"
SMTP_SECURE="true"
SMTP_USER="你的QQ邮箱@qq.com"
SMTP_PASS="你的QQ邮箱授权码"
SMTP_FROM="你的QQ邮箱@qq.com"
# 初始管理员：留空则【不会创建任何管理员】；需创建时填 12 位以上强密码
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="你的强密码至少12位"
EOF

# ✅ 成功标志：不报错，回到命令行提示符
# ⚠️ 注意：上面 JWT_SECRET、CLIENT_URL、SMTP_*、ADMIN_PASSWORD
#    都是「占位文字」，你必须先手动改好再粘贴！否则服务跑不起来。
#    若不想创建管理员，把 ADMIN_PASSWORD 留空（写成 ADMIN_PASSWORD=""）。


# ---------- 第 8 步：初始化数据库 ----------

cd /opt/movie-room/server
npx prisma db push
npx prisma generate

# ✅ 成功标志：看到 "Your database is now in sync with your schema"


# ---------- 第 9 步：构建前端 + 后端 ----------

cd /opt/movie-room
npm run build:client
npm run build:server

# ✅ 成功标志：前端出现 "✓ built in X.XXs"，后端无报错


# ---------- 第 10 步：启动服务 ----------

cd /opt/movie-room/server
pm2 start dist/index.js --name movie-room
pm2 save

# ✅ 成功标志：PM2 显示表格，status 为 online


# ---------- 第 11 步：验证 ----------

curl http://localhost:3001/api/health
# ✅ 成功标志：返回 {"status":"ok",...}

pm2 logs movie-room
# 看日志确认没有报错（按 Ctrl+C 退出日志）


# ============================================================
#  最后：去阿里云控制台「安全组」开放 3001 端口（入方向）
#  然后浏览器访问  http://你的公网IP:3001
# ============================================================
