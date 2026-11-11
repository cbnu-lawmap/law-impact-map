/*
 * 빼곡 — 최소 구조 HWPX(한글 문서) 만들기
 * 온지붕(slate-roof-gyeongsan) web/app/admin/hwpx.ts 를 빌드 도구 없는 자바스크립트로 옮김.
 * 표 없이 문단만 쓴다. 필요할 때 JSZip(cdnjs)을 불러온다.
 *
 *   Hwpx.build([{ text, style: "title" | "small" | undefined }, ...], "문서 제목") → Promise<Blob>
 */
(function (global) {
  "use strict";

  var JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

  var NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" ' +
    'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" ' +
    'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" ' +
    'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:dc="http://purl.org/dc/elements/1.1/"';

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  var LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
  var fontfaces = LANGS.map(function (l) {
    return '<hh:fontface lang="' + l + '" fontCnt="1"><hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"/></hh:fontface>';
  }).join("");

  // charPr 0: 본문 11pt, 1: 제목 16pt 굵게, 2: 작은 글씨 9pt, 3: 소제목 12pt 굵게
  function charPr(id, height, bold) {
    return '<hh:charPr id="' + id + '" height="' + height + '" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">' +
      '<hh:fontRef hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
      '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
      '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
      '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
      '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
      (bold ? "<hh:bold/>" : "") +
      '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/>' +
      '<hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>';
  }

  var HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    "<hh:head " + NS + ' version="1.4" secCnt="1">' +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    "<hh:refList>" +
    '<hh:fontfaces itemCnt="7">' + fontfaces + "</hh:fontfaces>" +
    '<hh:borderFills itemCnt="1"><hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
    '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
    '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
    '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
    '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill></hh:borderFills>' +
    '<hh:charProperties itemCnt="4">' + charPr(0, 1100, false) + charPr(1, 1600, true) + charPr(2, 900, false) + charPr(3, 1200, true) + "</hh:charProperties>" +
    '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
    '<hh:numberings itemCnt="0"/>' +
    '<hh:paraProperties itemCnt="1"><hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">' +
    '<hh:align horizontal="JUSTIFY" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>' +
    '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>' +
    '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
    '<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="600" unit="HWPUNIT"/></hh:margin>' +
    '<hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>' +
    '<hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr></hh:paraProperties>' +
    '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
    "</hh:refList>" +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:trackchageConfig flags="56"/></hh:head>';

  var SEC_PR = '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    '<hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY">' +
    '<hp:margin header="4252" footer="4252" gutter="0" left="7087" right="7087" top="5668" bottom="4252"/></hp:pagePr>' +
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>' +
    '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>' +
    '<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
    "</hp:secPr>";

  var zipPromise = null;
  function loadZip() {
    if (global.JSZip) return Promise.resolve(global.JSZip);
    if (!zipPromise) {
      zipPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = JSZIP;
        s.onload = function () { resolve(global.JSZip); };
        s.onerror = function () { zipPromise = null; reject(new Error("JSZip을 불러오지 못했습니다")); };
        document.head.appendChild(s);
      });
    }
    return zipPromise;
  }

  /** lines: [{text, style, pageBreak}] */
  function build(lines, title) {
    return loadZip().then(function (JSZip) {
      var paras = lines.map(function (ln, i) {
        var cp = ln.style === "title" ? 1 : ln.style === "small" ? 2 : ln.style === "head" ? 3 : 0;
        var ctrl = i === 0 ? SEC_PR + '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>' : "";
        return '<hp:p id="' + i + '" paraPrIDRef="0" styleIDRef="0" pageBreak="' + (ln.pageBreak ? 1 : 0) + '" columnBreak="0" merged="0">' +
          '<hp:run charPrIDRef="' + cp + '">' + ctrl + "<hp:t>" + esc(ln.text) + "</hp:t></hp:run></hp:p>";
      });
      var section = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ' + NS + ">" + paras.join("") + "</hs:sec>";
      var zip = new JSZip();
      zip.file("mimetype", "application/hwp+zip", { compression: "STORE" });
      zip.file("version.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="11, 0, 0, 0"/>');
      zip.file("META-INF/container.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>');
      zip.file("Contents/content.hpf", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package ' + NS + ' version="" unique-identifier="" id=""><opf:metadata><opf:title>' +
        esc(title || "문서") + "</opf:title><opf:language>ko</opf:language></opf:metadata>" +
        '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>' +
        '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>');
      zip.file("Contents/header.xml", HEADER);
      zip.file("Contents/section0.xml", section);
      return zip.generateAsync({ type: "blob", mimeType: "application/hwp+zip" });
    });
  }

  global.Hwpx = { build: build };
})(this);
