# Mixed CJK/Latin 排版测试：为什么中英混排会「高低不齐」

一句话版本：中文没有 x-height 的概念，但英文有；同一行里两种字的基线对齐规则不同，
所以**中文字体与西文字体必须分别指定**，只指定一个就会有一半的字看起来「掉下去」。

## 常见现象

1. 行内英文单词比中文高出一截，看起来像「上标」；
2. 数字与中文混排时行距忽大忽小；
3. 复制粘贴到别处，字体全变成默认的 Calibri，中文回退成某个系统字体。

## 正确做法

在 OOXML 里，字体是按字符集分槽存的，四个槽必须都显式写：

| 槽位 | 属性 | 管哪些字 |
| --- | --- | --- |
| 西文 | `w:ascii` | ASCII 可见字符 |
| 高位西文 | `w:hAnsi` | 扩展拉丁、希腊字母 |
| 中文/日文/韩文 | `w:eastAsia` | CJK 统一表意文字 |
| 复杂文种 | `w:cs` | 阿拉伯、希伯来等 |

反例（会让 Word 回退到主题字体，中文不一定是宋体）：

```
<w:rFonts w:eastAsiaTheme="minorEastAsia" />
```

正确写法：

```
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman" />
```

## 行内代码与公式混用

行内代码 `w:eastAsia` 与公式 $f(x) = \sin x + \cos x$ 混排时，

$$
\int_0^{\pi} \sin x \,\mathrm{d}x = 2
$$

公式块上下各留 6 磅间距即可，不要用空行去撑，空行会被当成新段落参与首行缩进。
