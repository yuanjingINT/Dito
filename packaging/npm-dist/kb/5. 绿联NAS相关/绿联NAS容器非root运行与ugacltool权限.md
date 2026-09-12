# 绿联 NAS 跑 Docker 容器用非 root 用户（ugacltool 权限）

安全最佳实践是让容器内进程以非 root 用户运行。但绿联 UGOS 用的是**自定义 ACL 系统**，标准 `chown`/`chmod` 在共享路径上不好使，要改用 `ugacltool` 设 ACL。

## 步骤

1. 在 NAS 上给每个容器建一个专用系统用户（同名同组）：
   ```bash
   sudo useradd --system --user-group --shell /usr/sbin/nologin nginx
   id nginx   # 记下 uid/gid，例如 uid=995(nginx) gid=991(nginx)
   ```

2. 用 `--user uid:gid` 跑容器：
   ```bash
   docker run -d --user 995:991 --name my_nginx_container nginx
   ```
   compose 里写：
   ```yaml
   services:
     web:
       image: nginx:stable
       user: "995:991"
       volumes:
         - ./html:/usr/share/nginx/html:ro
   ```

3. 用 `ugacltool` 给挂载路径授权（不要用 chown/chmod）：
   ```bash
   # 只读
   ugacltool add ./html group:nginx:allow:r-x---a-R-c--:-fd-
   # 读写（需要写数据的应用用这条）
   # ugacltool add ./html group:nginx:allow:rwxpdDaARWc--:-fd-
   # 查看当前 ACL
   ugacltool get ./html
   # 按索引删一条 ACL（只能删 level 0，先 get 查索引）
   ugacltool del_one ./html INDEX
   ```

4. 有些镜像默认绑 <1024 端口（需要 root），比如 nginx 的 80。改成高位端口即可。

## ugacltool 常用子命令

- `add PATH [ACL Entry]`：加 ACL
- `get PATH`：查看 ACL
- `del_one PATH INDEX`：按索引删除
- `del_all PATH`：清空 ACL
- `copy PATH_SRC PATH_DST`：复制 ACL
- `get_perm PATH USR`：查某用户的 Windows 权限
- `check PATH [ACL Perm]`：检查权限

ACL 条目格式：`[user|group|owner|everyone]:name:[allow|deny]:权限:继承模式`
- 权限位：`r`读 `w`写 `x`执行 `d`删 `D`删子项 `a/A`读写属性 `R/W`读写xattr `c/C`读写ACL `o`取所有权
- 继承：`f`文件继承 `d`目录继承 `i`仅继承 `n`不传播

## 参考

- UGREEN-NASync/community-guide 的 Run Docker Containers with Unprivileged Users 一文
