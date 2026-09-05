# Dito（蒂特）RPM 打包规格（Fedora / RHEL / Rocky / Alma 系）
#
# 构建方式（本机需先装 rpm-tools）：
#   ./packaging/build.sh
# 或手动：
#   rpmbuild -bb ~/rpmbuild/SPECS/dito.spec
#
# 说明：Dito 是 Node/TS 项目，无编译步骤（tsx 直接运行），
# 运行时依赖在 %build 阶段用 `npm ci` 装进 node_modules 一并打包。
# 注意：提交构建时必须加 --enable-net on（COPR 默认禁网会导致 npm ci 失败）。

Name:           dito
Version:        0.1.0
Release:        1%{?dist}
Summary:        Dito (TiTe) - AI assistant based on the pi agent

License:        MIT
URL:            https://pi.dev
Source0:        %{name}-%{version}.tar.gz

# 纯 Node/TS 包，无编译产物，禁用（会为空的）debuginfo 子包。
%global debug_package %{nil}

# node:sqlite (DatabaseSync) 需 Node >= 22.5；启动脚本会自动给 22.x / 23.0-23.3 加 --experimental-sqlite
BuildRequires:  nodejs
BuildRequires:  npm
Requires:       nodejs >= 22.5
Requires:       bash

%description
Dito（蒂特）—— 基于 pi agent 的个人 AI 助手。
提供语音对话、本地知识库、跨会话记忆、提示词（人设/用户身份）设定、
联网搜索，以及高危命令确认门。默认模型为 opencode 免费公共模型，
开箱即用，无需 API Key。

%prep
%autosetup -n %{name}-%{version}

%build
# TypeScript 无独立编译步骤，运行时由 tsx 直接加载；
# 这里只安装运行时依赖，node_modules 会被一并打包进 RPM。
npm ci --omit=dev --no-audit --no-fund
# 提示词加密包 desktop/prompts/dito-prompts.bin 已由 packaging/build.sh 在源码包中生成；
# RPM 内不携带 personas/identities/system-prompts 明文提示词目录。

%install
# 应用整体安装到 %{_libexecdir}/dito（私有可执行目录），
# 运行时扩展通过相对自身路径解析 desktop/prompts 加密包与 kb 等资源。
install -d %{buildroot}%{_libexecdir}/%{name}
cp -a bin extensions desktop web-ui scripts kb config skills .pi \
      package.json package-lock.json \
      %{buildroot}%{_libexecdir}/%{name}/
cp -a node_modules %{buildroot}%{_libexecdir}/%{name}/

# 启动器软链到 PATH
install -d %{buildroot}%{_bindir}
ln -s ../libexec/%{name}/bin/dito %{buildroot}%{_bindir}/dito
ln -s ../libexec/%{name}/bin/dito-desktop %{buildroot}%{_bindir}/dito-desktop

%files
%{_bindir}/dito
%{_bindir}/dito-desktop
%{_libexecdir}/%{name}
%doc README.md

%changelog
* Fri Aug 14 2026 yuanjing <yuanjing@localhost> - 0.1.0-1
- Initial RPM packaging of Dito
