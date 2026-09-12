Steam的webhelper是基于chromium的，在x11运行的时候用的输入法模块是GTK_IM_MODULE，但是Steam只加载了xim、cedilla 和 wayland 的模块。模块是按照locale激活的，LC_CTYPE为英文的时候激活的是 cedilla，这个不支持中文输入，于是没法使用输入法了。解决办法是手动指定使用xim，env GTK_IM_MODULE=xim steam。

可以对比一下三条命令的效果：

```
env LC_CTYPE=zh_CN.UTF-8 XMODIFIERS=@im=fcitx steam
env LC_CTYPE=en_US.UTF-8 XMODIFIERS=@im=fcitx steam
env LC_CTYPE=en_US.UTF-8 GTK_IM_MODULE=xim XMODIFIERS=@im=fcitx steam
```
只有加上`GTK_IM_MODULE=xim`的能用输入法。
