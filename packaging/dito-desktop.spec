# Dito 桌面版 RPM 打包规格（Electron 独立应用）
#
# 构建方式：./packaging/build-desktop-rpm.sh
# 前置：先运行 `npm run desktop:pack` 生成 dist/linux-unpacked。

Name:           dito-desktop
Version:        0.1.0
Release:        1%{?dist}
Summary:        Dito (TiTe) desktop app

License:        MIT
URL:            https://pi.dev
Source0:        %{name}-%{version}.tar.gz

BuildArch:      x86_64
%global debug_package %{nil}

%description
Dito（蒂特）桌面版：基于 Electron 的独立窗口应用，UI 采用 Xiaomi MiMo
浅色暖调设计。提示词使用 AES-256-GCM 加密存储，应用内不携带明文
personas / identities / system-prompts 目录。

%prep
%autosetup -n %{name}-%{version}

%build
# Electron 应用已在 dist/linux-unpacked 中由 electron-builder 构建完成，这里无需编译。

%install
install -d %{buildroot}%{_libexecdir}/%{name}
cp -a . %{buildroot}%{_libexecdir}/%{name}/

# 启动器
install -d %{buildroot}%{_bindir}
ln -s ../libexec/%{name}/dito %{buildroot}%{_bindir}/dito-desktop

# 应用图标
install -d %{buildroot}%{_datadir}/icons/hicolor/512x512/apps
cp -a dito-desktop.png %{buildroot}%{_datadir}/icons/hicolor/512x512/apps/dito-desktop.png

# 桌面入口
install -d %{buildroot}%{_datadir}/applications
cat > %{buildroot}%{_datadir}/applications/dito-desktop.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Dito（蒂特）
Name[zh_CN]=Dito（蒂特）
Comment=AI 助手桌面版
Comment[zh_CN]=AI 助手桌面版
Exec=/usr/bin/dito-desktop
Icon=dito-desktop
Terminal=false
Categories=Utility;AI;
StartupWMClass=Dito
DESKTOP

%files
%{_bindir}/dito-desktop
%{_libexecdir}/%{name}
%{_datadir}/applications/dito-desktop.desktop
%{_datadir}/icons/hicolor/512x512/apps/dito-desktop.png

%changelog
* Sun Aug 16 2026 yuanjing <yuanjing@localhost> - 0.1.0-1
- Desktop RPM packaging of Dito with encrypted prompts
