"""
Update the master workbook ("Vetbuddy Master Data 2.xlsx") in place, without
loading it into memory (it has 300k+ rows / 60 MB):

  * rows whose date (column B) is in the report month are removed
  * empty rows at the bottom are removed (e.g. rows that were cleared, not deleted)
  * the new month-to-date rows are pasted directly under the last real row
  * AX  = =INT(B)  in every row (the date without time; correct in any language setting)
  * AY  = "VOW Unit": CH / CBE / MADURAI / TRICHY VET ON WHEELS for every line of a
          Vet on Wheels invoice, empty for clinic sales (rules in vow.py)
  * the filter range is extended to the new last row

Older months' values are never changed (only their AX formula and AY flag are
(re)written). If anything looks unexpected, nothing is changed.
"""

import datetime as dt
import logging
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import vow

log = logging.getLogger("vetbuddy")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
EPOCH = dt.datetime(1899, 12, 30)
VOW_HEADER = "VOW Unit"
AY = "AY"

_ROW_RE = re.compile(rb"<row [^>]*/>|<row [^>]*[^/]>.*?</row>|<row>.*?</row>", re.S)
_V_RE = re.compile(rb"<v>([^<]*)</v>")
_T_RE = re.compile(rb"<t[^>]*>([^<]*)</t>")
_CELL_S_RE = re.compile(rb'<c r="([A-Z]+)\d+"(?:[^>]*?\ss="(\d+)")?')
_CELL_RES: dict = {}


# ---------------------------------------------------------------- small helpers
def col_letter(i: int) -> str:  # 0 -> A
    s, i = "", i + 1
    while i:
        i, rem = divmod(i - 1, 26)
        s = chr(65 + rem) + s
    return s


def _cell_re(col: str):
    if col not in _CELL_RES:
        _CELL_RES[col] = re.compile(rb'<c r="' + col.encode() + rb'\d+"([^>]*?)(?:/>|>(.*?)</c>)', re.S)
    return _CELL_RES[col]


def _xml_text(v: str) -> str:
    v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", v)
    return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _unescape(b: bytes) -> str:
    return (b.decode("utf-8").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&"))


def cell_value(row: bytes, col: str, ss: list):
    """Value of one cell in a raw <row> (text, float or None)."""
    m = _cell_re(col).search(row)
    if not m or not m.group(2):
        return None
    attrs, inner = m.group(1) or b"", m.group(2)
    if b't="s"' in attrs:
        v = _V_RE.search(inner)
        return ss[int(v.group(1))] if v else None
    if b't="inlineStr"' in attrs or b't="str"' in attrs:
        t = _T_RE.search(inner) or _V_RE.search(inner)
        return _unescape(t.group(1)) if t else None
    v = _V_RE.search(inner)
    if not v:
        return None
    try:
        return float(v.group(1))
    except ValueError:
        return _unescape(v.group(1))


def _cell_style(row: bytes, col: str):
    m = _cell_re(col).search(row)
    if not m:
        return None
    s = re.search(rb'\ss="(\d+)"', m.group(1) or b"")
    return s.group(1).decode() if s else None


def _row_num(row: bytes) -> int:
    return int(re.search(rb'<row [^>]*?\br="(\d+)"', row).group(1))


def row_month(row: bytes):
    """(year, month) from column B (real VetBuddy date+time); AX as fallback."""
    for col in ("B", "AX"):
        m = _cell_re(col).search(row)
        if m and m.group(2):
            a = m.group(1) or b""
            if b't="' in a and b't="n"' not in a:
                continue
            v = _V_RE.search(m.group(2))
            if v:
                try:
                    d = EPOCH + dt.timedelta(days=float(v.group(1)))
                    return d.year, d.month
                except (ValueError, OverflowError):
                    pass
    return None


def is_blank_row(row: bytes) -> bool:
    """No values in any column (the AX formula and AY flag don't count)."""
    rest = _cell_re("AX").sub(b"", row)
    rest = _cell_re(AY).sub(b"", rest)
    return b"<v>" not in rest and b"<is>" not in rest and b"<v " not in rest


# ---------------------------------------------------------------- cell writers
def ax_cell(r: int, style, b_serial) -> str:
    sa = f' s="{style}"' if style else ""
    v = f"<v>{int(b_serial)}</v>" if b_serial is not None else ""
    return f'<c r="AX{r}"{sa}><f>INT(B{r})</f>{v}</c>'


def text_cell(col: str, r: int, style, text: str) -> str:
    sa = f' s="{style}"' if style else ""
    if not text:
        return f'<c r="{col}{r}"{sa}/>' if style else ""
    return f'<c r="{col}{r}"{sa} t="inlineStr"><is><t>{_xml_text(text)}</t></is></c>'


def set_ax_ay(row: bytes, r: int, ay_text: str, ay_style) -> bytes:
    """Rewrite AX as =INT(Br) and AY as the VOW unit, keep everything else as is."""
    b = None
    bm = _cell_re("B").search(row)
    if bm and bm.group(2) and (b't="' not in (bm.group(1) or b"") or b't="n"' in bm.group(1)):
        v = _V_RE.search(bm.group(2))
        if v:
            try:
                b = float(v.group(1))
            except ValueError:
                pass
    ax_style = _cell_style(row, "AX")
    # remove old AX/AY, then insert both right after the last cell before AX
    row = _cell_re("AX").sub(b"", row)
    row = _cell_re(AY).sub(b"", row)
    new = (ax_cell(r, ax_style, b) if (b is not None or ax_style) else "") + \
        text_cell(AY, r, ay_style if ay_text else None, ay_text)
    if not new:
        return row
    after = re.search(rb'<c r="(?:A[Z]|[B-Z][A-Z])\d+"', row)  # any column after AY
    i = after.start() if after else row.rfind(b"</row>")
    return row[:i] + new.encode("utf-8") + row[i:]


def new_row_xml(r: int, vals: list, styles: dict, ncols: int, ay_text: str) -> str:
    parts = [f'<row r="{r}" spans="1:{ncols + 2}">']
    for c in range(ncols):
        col = col_letter(c)
        s = styles.get(col)
        sa = f' s="{s}"' if s else ""
        v = vals[c] if c < len(vals) else None
        if isinstance(v, dt.datetime):
            v = (v - EPOCH).total_seconds() / 86400
        if v is None or v == "":
            parts.append(f'<c r="{col}{r}"{sa}/>')
        elif isinstance(v, bool):
            parts.append(f'<c r="{col}{r}"{sa} t="b"><v>{int(v)}</v></c>')
        elif isinstance(v, (int, float)):
            parts.append(f'<c r="{col}{r}"{sa}><v>{repr(v) if isinstance(v, float) else v}</v></c>')
        else:
            t = _xml_text(str(v))
            sp = ' xml:space="preserve"' if t != t.strip() else ""
            parts.append(f'<c r="{col}{r}"{sa} t="inlineStr"><is><t{sp}>{t}</t></is></c>')
    b = vals[1] if len(vals) > 1 else None
    serial = (b - EPOCH).total_seconds() / 86400 if isinstance(b, dt.datetime) else None
    parts.append(ax_cell(r, styles.get("AX"), serial))
    parts.append(text_cell(AY, r, (styles.get(AY) or styles.get("AW")) if ay_text else None, ay_text))
    parts.append("</row>")
    return "".join(parts)


# ---------------------------------------------------------------- reading the sheet
def _sheet_part(z: zipfile.ZipFile) -> str:
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rid = re.search(r'<sheet [^>]*r:id="([^"]+)"', wb).group(1)
    m = re.search(rf'<Relationship [^>]*Id="{rid}"[^>]*Target="([^"]+)"', rels) or \
        re.search(rf'<Relationship [^>]*Target="([^"]+)"[^>]*Id="{rid}"', rels)
    return "xl/" + m.group(1).lstrip("/").replace("xl/", "", 1)


def shared_strings(z: zipfile.ZipFile) -> list:
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for _, el in ET.iterparse(z.open("xl/sharedStrings.xml")):
            if el.tag == NS + "si":
                ss.append("".join(el.itertext()))
                el.clear()
    return ss


def stream_sheet(z: zipfile.ZipFile, part: str):
    """Yields ('prefix', bytes) once, ('row', bytes) per row, ('tail', bytes) once."""
    with z.open(part) as f:
        buf, prefix_done = b"", False
        while True:
            chunk = f.read(16 << 20)
            data = buf + chunk
            if not prefix_done:
                if b"<sheetData/>" in data:
                    data = data.replace(b"<sheetData/>", b"<sheetData></sheetData>", 1)
                i = data.find(b"<sheetData>")
                if i == -1:
                    if not chunk:
                        raise RuntimeError("Master sheet has no data section")
                    buf = data
                    continue
                yield "prefix", data[: i + len(b"<sheetData>")]
                data = data[i + len(b"<sheetData>"):]
                prefix_done = True
            end = data.find(b"</sheetData>")
            limit = end if end != -1 else max(data.rfind(b"</row>") + 6, 0)
            pos = 0
            for m in _ROW_RE.finditer(data, 0, limit):
                yield "row", m.group(0)
                pos = m.end()
            if end != -1:
                yield "tail", data[end:] + f.read()
                return
            buf = data[pos:]
            if not chunk:
                raise RuntimeError("Master sheet XML ended unexpectedly")


# ---------------------------------------------------------------- main function
def update_master_file(src_path: Path, dst_path: Path, rows: list, month: tuple) -> dict:
    """rows = header + data rows of the new month-to-date export; month = (year, month)."""
    header = list(rows[0])
    while header and (header[-1] is None or str(header[-1]).strip() == ""):
        header.pop()  # the .xls carries empty trailing columns
    ncols = len(header)                               # 49 = A..AW
    data = [list(r[:ncols]) + [None] * (ncols - len(r)) for r in rows[1:]]
    idx = {str(h).strip().lower(): i for i, h in enumerate(header)}
    i_inv, i_item, i_clinic = idx["invoice #"], idx["services and goods"], idx["billed clinic"]
    col_inv, col_item, col_clinic = col_letter(i_inv), col_letter(i_item), col_letter(i_clinic)

    zin = zipfile.ZipFile(src_path)
    part = _sheet_part(zin)
    ss = shared_strings(zin)

    # ---- 1. header check (A..AW must match the export; AY must be free or ours)
    head_row = next(b for kind, b in stream_sheet(zin, part) if kind == "row")
    got = [str(cell_value(head_row, col_letter(i), ss) or "").strip().lower() for i in range(ncols)]
    exp = [str(h).strip().lower() for h in header]
    if got != exp:
        diff = [(col_letter(i), a, b) for i, (a, b) in enumerate(zip(exp, got)) if a != b][:5]
        raise RuntimeError(f"Master columns don't match the export {diff} - master NOT changed")
    ay_head = str(cell_value(head_row, AY, ss) or "").strip()
    if ay_head and ay_head.lower() != VOW_HEADER.lower():
        raise RuntimeError(f"Column AY already holds '{ay_head}' - master NOT changed")

    # ---- 2. first pass: which invoices are Vet on Wheels (kept rows + new rows)
    vow_invoices = set()
    for kind, row in stream_sheet(zin, part):
        if kind != "row" or _row_num(row) == 1 or row_month(row) == month:
            continue
        if vow.is_vow_item(cell_value(row, col_item, ss)):
            vow_invoices.add(vow.norm_invoice(cell_value(row, col_inv, ss)))
    for vals in data:
        if vow.is_vow_item(vals[i_item]):
            vow_invoices.add(vow.norm_invoice(vals[i_inv]))
    vow_invoices.discard(None)

    # ---- 3. second pass: write the new sheet
    stats = {"removed": 0, "kept": 0, "added": len(data), "empty_rows_dropped": 0,
             "vow_lines": 0, "vow_invoices": 0}
    last_kept_r, last_kept_xml = 1, b""
    style_votes: dict = {}
    voted = 0
    pending_blank: list = []
    seen_target = False
    tail = b""
    vow_inv_seen = set()

    tmp = dst_path.with_name(dst_path.name + ".sheet.tmp")
    with open(tmp, "wb") as out:
        for kind, row in stream_sheet(zin, part):
            if kind == "prefix":
                out.write(row)
                continue
            if kind == "tail":
                tail = row
                break
            r = _row_num(row)
            if r == 1:  # header: add "VOW Unit" in AY
                row = _cell_re(AY).sub(b"", row)
                cell = text_cell(AY, 1, _cell_style(row, "AX"), VOW_HEADER).encode()
                i = row.rfind(b"</row>")
                out.write(row[:i] + cell + row[i:])
                last_kept_r = 1
                continue
            if is_blank_row(row):
                pending_blank.append(row)  # kept only if real data follows
                continue
            if row_month(row) == month:  # replaced by the new export
                stats["empty_rows_dropped"] += len(pending_blank)
                pending_blank.clear()
                if voted < 3000:  # remember these rows' look for the new rows
                    voted += 1
                    for cm in _CELL_S_RE.finditer(row):
                        k = (cm.group(1).decode(), cm.group(2).decode() if cm.group(2) else None)
                        style_votes[k] = style_votes.get(k, 0) + 1
                seen_target = True
                stats["removed"] += 1
                continue
            if seen_target:
                raise RuntimeError(f"Unexpected layout: row {r} (another month) comes after the "
                                   f"{month[1]:02d}/{month[0]} rows - master NOT changed")
            for b in pending_blank:
                out.write(b)
            pending_blank.clear()
            inv = vow.norm_invoice(cell_value(row, col_inv, ss))
            ay_text = vow.vow_unit_for_line(inv, cell_value(row, col_clinic, ss), vow_invoices)
            if ay_text:
                stats["vow_lines"] += 1
                vow_inv_seen.add(inv)
            row = set_ax_ay(row, r, ay_text, _cell_style(row, col_clinic))
            out.write(row)
            stats["kept"] += 1
            last_kept_r, last_kept_xml = r, row
        stats["empty_rows_dropped"] += len(pending_blank)

        # styles for the new rows: most common style of the replaced rows, else last row
        if style_votes:
            styles = {}
            for (col, s), _n in sorted(style_votes.items(), key=lambda kv: kv[1]):
                styles[col] = s
        else:
            styles = {m.group(1).decode(): (m.group(2).decode() if m.group(2) else None)
                      for m in _CELL_S_RE.finditer(last_kept_xml)}

        r = last_kept_r
        new_rows = []
        for vals in data:
            r += 1
            ay_text = vow.vow_unit_for_line(vals[i_inv], vals[i_clinic], vow_invoices)
            if ay_text:
                stats["vow_lines"] += 1
                vow_inv_seen.add(vow.norm_invoice(vals[i_inv]))
            new_rows.append(new_row_xml(r, vals, styles, ncols, ay_text))
        last_row = r
        try:  # the new rows must be valid before anything is uploaded
            parsed = ET.fromstring(f'<sheetData xmlns="{NS[1:-1]}">' + "".join(new_rows) + "</sheetData>")
        except ET.ParseError as e:
            raise RuntimeError(f"Generated rows are not valid ({e}) - master NOT changed") from e
        if len(parsed) != len(data):
            raise RuntimeError("Generated row count mismatch - master NOT changed")
        for x in new_rows:
            out.write(x.encode("utf-8"))

        t = tail.decode("utf-8")  # filter range: A1:AY<last row>
        t = re.sub(r'(<autoFilter ref=")([A-Z]+)1:[A-Z]+\d+', lambda m: f"{m.group(1)}{m.group(2)}1:{AY}{last_row}", t, 1)
        out.write(t.encode("utf-8"))
    stats["last_row"] = last_row
    stats["vow_invoices"] = len(vow_inv_seen)

    # ---- 4. rebuild the .xlsx: new sheet, workbook settings, no calcChain (Excel rebuilds it)
    with zipfile.ZipFile(dst_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zout:
        for item in zin.infolist():
            name = item.filename
            if name == "xl/calcChain.xml":
                continue
            if name == part:
                with open(tmp, "rb") as fsrc, zout.open(name, "w", force_zip64=True) as zf:
                    head = fsrc.read(1 << 20)
                    head = re.sub(rb'<dimension ref="([A-Z]+)1:[A-Z]+\d+"/>',
                                  lambda m: b'<dimension ref="%s1:%s%d"/>' % (m.group(1), AY.encode(), last_row),
                                  head, 1)
                    zf.write(head)
                    while True:
                        b = fsrc.read(16 << 20)
                        if not b:
                            break
                        zf.write(b)
                continue
            content = zin.read(name)
            if name == "xl/workbook.xml":
                s = content.decode("utf-8")
                s = re.sub(r"(_xlnm\._FilterDatabase[^>]*>[^<]*!\$[A-Z]+\$1:\$)[A-Z]+\$\d+",
                           lambda m: f"{m.group(1)}{AY}${last_row}", s)
                if "<calcPr" in s:
                    s = re.sub(r'<calcPr([^>]*?)\s*fullCalcOnLoad="[^"]*"', r"<calcPr\1", s)
                    s = s.replace("<calcPr", '<calcPr fullCalcOnLoad="1"', 1)
                else:
                    s = s.replace("</workbook>", '<calcPr fullCalcOnLoad="1"/></workbook>')
                content = s.encode("utf-8")
            elif name == "xl/_rels/workbook.xml.rels":
                content = re.sub(rb"<Relationship [^>]*calcChain[^>]*/>", b"", content)
            elif name == "[Content_Types].xml":
                content = re.sub(rb"<Override [^>]*calcChain[^>]*/>", b"", content)
            zout.writestr(item, content)
    tmp.unlink()
    zin.close()
    return stats
