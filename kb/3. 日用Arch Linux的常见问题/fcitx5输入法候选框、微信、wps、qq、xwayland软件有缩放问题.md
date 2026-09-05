- wps

  可以试试用这个环境变量启动wps：QT_SCALE_FACTOR QT_AUTO_SCREEN_SCALE_FACTOR=0 QT_SCREEN_SCALE_FACTORS="1.25" QT_FONT_DPI=120

- 输入法候选框过小
  
  1. 安装xorg-xrdb
  
  2. 计算dpi，用标准dpi乘屏幕缩放，标准dpi通常是96。1.5倍缩放就是：96x1.5=144
  
  3. echo "Xft.dpi: 144" | xrdb -merge

  4. 设置启动时自动运行此命令，或者在.Xresources写入：Xft.dpi: 144。


