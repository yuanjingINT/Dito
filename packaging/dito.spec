Name:           dito
Version:        0.3.0~alpha
Release:        1%{?dist}
Summary:        Dito native C AI assistant
License:        GPL-3.0-only
URL:            https://github.com/yuanjingINT/Dito
Source0:        %{name}-%{version}.tar.gz
BuildRequires:  gcc
BuildRequires:  cmake
BuildRequires:  pkgconfig(libcurl)
BuildRequires:  pkgconfig(json-c)
BuildRequires:  pkgconfig(sqlite3)
BuildRequires:  pkgconfig(ncursesw)
BuildRequires:  pkgconfig(openssl)
BuildRequires:  pkgconfig(libxml-2.0)

%description
Native C terminal, streaming model client, tools, sessions and memory.
Legacy compatibility dependencies are available through the user installer.

%prep
%autosetup

%build
cmake -S c -B c/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=%{_prefix}
cmake --build c/build --parallel

%check
ctest --test-dir c/build --output-on-failure

%install
DESTDIR=%{buildroot} cmake --install c/build

%files
%{_bindir}/dito
%{_prefix}/lib/dito
%license LICENSE
%doc README.md
