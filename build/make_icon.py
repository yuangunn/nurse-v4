"""
NurseScheduler 앱 아이콘 생성
- Windows .ico (다중 해상도: 16, 32, 48, 64, 128, 256)
- 디자인: 블루 그라디언트 둥근 사각형 + 달력 + 체크마크
"""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
ICO_PATH = os.path.join(OUT_DIR, "icon.ico")
PNG_PATH = os.path.join(OUT_DIR, "icon.png")

# 색상 팔레트 (기존 앱 Accent 컬러 기반)
BG_TOP = (59, 130, 246)      # #3b82f6 (blue-500)
BG_BOTTOM = (29, 78, 216)    # #1d4ed8 (blue-700)
ACCENT = (255, 255, 255)     # 흰색
CHECK = (34, 197, 94)        # #22c55e (green-500) — 체크마크 강조


def rounded_rect_mask(size, radius):
    """둥근 사각형 알파 마스크"""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def gradient(size, top_color, bottom_color):
    """세로 그라디언트"""
    base = Image.new("RGB", size, top_color)
    top = Image.new("RGB", size, top_color)
    bot = Image.new("RGB", size, bottom_color)
    mask = Image.new("L", size)
    for y in range(size[1]):
        t = y / (size[1] - 1)
        mask.putpixel((0, y), int(255 * t))
    # 전체 폭으로 확장
    mask = mask.resize(size)
    return Image.composite(bot, top, mask)


def draw_icon(size):
    """size x size 아이콘 생성"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 1. 둥근 사각형 배경 (그라디언트)
    radius = int(size * 0.22)
    bg = gradient((size, size), BG_TOP, BG_BOTTOM)
    mask = rounded_rect_mask((size, size), radius)
    bg_rgba = bg.convert("RGBA")
    bg_rgba.putalpha(mask)
    img = Image.alpha_composite(img, bg_rgba)

    # 미세한 하이라이트 (상단 반사광)
    highlight = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    hd.ellipse(
        [-size * 0.2, -size * 0.6, size * 1.2, size * 0.5],
        fill=(255, 255, 255, 40),
    )
    hmask = rounded_rect_mask((size, size), radius)
    highlight.putalpha(Image.eval(hmask, lambda x: min(x, 60)))
    img = Image.alpha_composite(img, highlight)

    # 2. 달력 본체
    draw = ImageDraw.Draw(img)

    cal_w = int(size * 0.56)
    cal_h = int(size * 0.50)
    cal_x = (size - cal_w) // 2
    cal_y = int(size * 0.30)
    cal_radius = max(2, int(size * 0.04))

    # 달력 배경 (흰색)
    draw.rounded_rectangle(
        [cal_x, cal_y, cal_x + cal_w, cal_y + cal_h],
        radius=cal_radius,
        fill=ACCENT,
    )

    # 달력 상단 바 (짙은 파랑)
    header_h = int(cal_h * 0.22)
    draw.rounded_rectangle(
        [cal_x, cal_y, cal_x + cal_w, cal_y + header_h + cal_radius],
        radius=cal_radius,
        fill=BG_BOTTOM,
    )
    # 상단 바 아래 직사각형으로 윤곽 맞추기
    draw.rectangle(
        [cal_x, cal_y + cal_radius, cal_x + cal_w, cal_y + header_h],
        fill=BG_BOTTOM,
    )

    # 달력 고리 (2개)
    ring_r = max(1, int(size * 0.020))
    ring_y = cal_y - ring_r
    ring_x1 = cal_x + int(cal_w * 0.25)
    ring_x2 = cal_x + int(cal_w * 0.75)
    for rx in (ring_x1, ring_x2):
        draw.rounded_rectangle(
            [rx - ring_r, ring_y, rx + ring_r, ring_y + int(size * 0.08)],
            radius=ring_r,
            fill=ACCENT,
        )

    # 3. 체크마크 (달력 본체 중앙)
    if size >= 32:
        # 두께는 사이즈 비례
        check_w = max(2, int(size * 0.05))
        body_cy = cal_y + header_h + (cal_h - header_h) // 2
        check_size = int(cal_w * 0.45)
        cx = size // 2
        # V자 체크마크 좌표
        p1 = (cx - check_size // 2, body_cy)
        p2 = (cx - check_size // 8, body_cy + check_size // 3)
        p3 = (cx + check_size // 2, body_cy - check_size // 3)
        draw.line([p1, p2], fill=CHECK, width=check_w, joint="curve")
        draw.line([p2, p3], fill=CHECK, width=check_w, joint="curve")
        # 둥근 끝 (원으로 마감)
        for pt in (p1, p2, p3):
            r = check_w // 2
            draw.ellipse(
                [pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r],
                fill=CHECK,
            )

    return img


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = []
    for s in sizes:
        # 고해상도로 그리고 축소 (안티앨리어싱)
        render_size = max(s * 2, 512)
        big = draw_icon(render_size)
        resized = big.resize((s, s), Image.LANCZOS)
        images.append(resized)

    # 256x256 PNG (Electron용)
    images[-1].save(PNG_PATH, "PNG")
    print(f"PNG: {PNG_PATH}")

    # ICO: 가장 큰 이미지(256x256)로 저장하고 sizes 파라미터로 다중 크기 지정
    # PIL이 자동으로 축소판 생성
    images[-1].save(
        ICO_PATH,
        format="ICO",
        sizes=[(s, s) for s in sizes],
    )
    # 검증
    from PIL import Image as PILImage
    with PILImage.open(ICO_PATH) as ico:
        print(f"ICO: {ICO_PATH} ({ico.size[0]}x{ico.size[1]}, {os.path.getsize(ICO_PATH)} bytes)")


if __name__ == "__main__":
    main()
