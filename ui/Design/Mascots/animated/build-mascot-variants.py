"""Build animated SVG variants for the six alternate mascots.

Reads nothing: source geometry (verified against Design/Mascots/Group *.svg)
is embedded below. Writes 20 files next to this script:
  {spider,ghost,bunny,horned,spiky}-{idle,happy,sleepy,spin}.svg

Motion language matches public/creature-expressions.svg + Design/mascot-spec.md:
  float 4.8s / eyes-only blink 6.8s / gaze 6.8s, prefers-reduced-motion off.
  Happy/sleepy variants do not blink.
  Spin keeps the body fully static while the face (eyes + mouth) travels:
  exits left, fades, slams back in from the right with a slight overshoot
  past center, settles home (2.4s loop). Pure 2D, so it
  reads the same in every viewer (inline SVG, <img>, Quick Look).

Every file namespaces its classes/keyframes (m-<name>-<variant>-*), because
the files are designed to be inlined together on one page: identically-named
rules in one file must never animate another file's groups. Only the
--mascot-body / --mascot-ink custom properties are intentionally global.

Run from anywhere:  python3 Design/Mascots/animated/build-mascot-variants.py
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))


def _rule(ns, selector, decl):
    return '    .' + ns + ' ' + selector + '{' + decl + '}\n'


def _keyframes(ns, name, body):
    return '    @keyframes ' + ns + '-' + name + '{' + body + '}\n'


def css_for(ns, body_default, blink, slide):
    """Stylesheet for one file. slide is like '23px' (spin) or None."""
    c = ''
    c += _rule(ns, '.mascot-body', 'fill:var(--mascot-body,' + body_default + ');')
    c += _rule(ns, '.eye-white', 'fill:#fff;')
    c += _rule(ns, '.pupil', 'fill:var(--mascot-ink,#24211f);')
    c += _rule(ns, '.ink', 'fill:var(--mascot-ink,#24211f);stroke:none;')
    c += _rule(ns, '.mouth', 'fill:none;stroke:var(--mascot-ink,#24211f);stroke-linecap:round;')
    c += _rule(ns, '.eye-arc', 'fill:none;stroke:var(--mascot-ink,#24211f);stroke-linecap:round;')
    c += _rule(ns, '.mascot-idle', 'transform-box:fill-box;transform-origin:center;'
               'animation:' + ns + '-float 4.8s cubic-bezier(.37,0,.22,1) infinite;')
    c += _rule(ns, '.pupil', 'transform-box:fill-box;transform-origin:center;'
               'animation:' + ns + '-gaze 6.8s cubic-bezier(.37,0,.22,1) infinite;')
    if blink:
        c += _rule(ns, '.mascot-blink', 'transform-box:fill-box;transform-origin:center;'
                   'animation:' + ns + '-blink 6.8s linear infinite;')
    if slide is not None:
        c += _rule(ns, '.mascot-travelface', 'transform-box:fill-box;transform-origin:center;'
                   'animation:' + ns + '-travel 2.4s linear infinite;')
    if slide is None:
        c += _keyframes(ns, 'float', '0%,100%{translate:0 0;}45%,55%{translate:0 -4px;}')
    if blink:
        c += _keyframes(ns, 'blink', '0%,31%,34%,72%,75%,100%{scale:1 1;}32%,73%{scale:1 .04;}')
    c += _keyframes(ns, 'gaze', '0%,16%,100%{translate:0 0;}31%,48%{translate:3px -1px;}'
                                '64%,80%{translate:-3px 1px;}')
    if slide is not None:
        sp = '%dpx' % slide
        ov = '%dpx' % max(6, round(slide * 0.15))
        c += _keyframes(ns, 'travel', '0%,10%{translate:0px 0px;opacity:1;'
                                      'animation-timing-function:ease-in;}'
                                      '32%{translate:-' + sp + ' 0px;opacity:0;'
                                      'animation-timing-function:linear;}'
                                      '52%{translate:' + sp + ' 0px;opacity:0;'
                                      'animation-timing-function:ease-out;}'
                                      '70%{translate:-' + ov + ' 0px;opacity:1;'
                                      'animation-timing-function:ease-out;}'
                                      '80%,100%{translate:0px 0px;opacity:1;}')
    rm = ('.' + ns + ' .mascot-idle,.' + ns + ' .mascot-blink,.' + ns + ' .pupil,.'
          + ns + ' .mascot-travelface')
    c += '    @media (prefers-reduced-motion:reduce){' + rm + '{animation:none;}}\n'
    return c


def build(name, w, h, vb, body_default, label, body, face, eyes, variant, spin,
          blink, slide):
    ns = 'm-' + name + '-' + variant
    css = css_for(ns, body_default, blink, slide if spin else None)
    face_group = '<g class="mascot-face">' + face + '</g>' if face else ''
    eyes_group = '<g class="mascot-blink"><g class="mascot-eyes">' + eyes + '</g></g>'
    if spin:
        inner = ('<g class="' + ns + '"><g class="mascot-idle">'
                 '<g class="mascot-body">' + body + '</g>'
                 '<g class="mascot-travelface">' + face_group + eyes_group + '</g>'
                 '</g></g>')
    else:
        inner = ('<g class="' + ns + '"><g class="mascot-idle"><g class="mascot-body">'
                 + body + '</g>' + face_group + eyes_group + '</g></g>')
    vlabel = {'idle': 'idle', 'happy': 'happy', 'sleepy': 'sleepy',
              'spin': 'spinning'}[variant]
    if variant == 'spin':
        desc = 'Animated ' + label + ' mascot, face travelling round and back.'
    else:
        desc = 'Animated ' + label + ' mascot, ' + vlabel + ' expression.'
    return (
        '<svg width="' + str(w) + '" height="' + str(h) + '" viewBox="' + vb + '" fill="none" '
        'xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="' + label + ' mascot, ' + vlabel + '">\n'
        '  <style>\n' + css + '  </style>\n'
        '  <title>' + label + ' mascot (' + vlabel + ')</title>'
        '<desc>' + desc + '</desc>\n'
        '  ' + inner + '\n</svg>\n'
    )


def arc(d, width):
    return '<path class="eye-arc" d="' + d + '" stroke-width="' + str(width) + '"/>'


def ell(cx, cy, rx, ry, cls="pupil"):
    return ('<ellipse class="' + cls + '" cx="' + str(cx) + '" cy="' + str(cy)
            + '" rx="' + str(rx) + '" ry="' + str(ry) + '"/>')

# --------------------------------------------------------------------------
# Per-mascot source data (geometry copied verbatim from Design/Mascots).
# --------------------------------------------------------------------------
MASCOTS = {
    # White spider/flower, one big black eye + highlight. Source: Group 54.
    "spider": dict(
        vb="0 0 161 156", w=161, h=156, body_default="#ffffff",
        label="Spider",
        body='<path class="mascot-body" d="M5.24005 127.504C-9.73329 113.793 '
             '10.8571 92.6057 23.6218 83.241C24.0091 82.9569 24.5357 83.0006 '
             '24.8835 83.3319L48.0167 105.373C48.3601 105.701 48.4323 106.216 '
             '48.1768 106.616C39.8103 119.703 20.2127 141.214 5.24005 127.504Z"/>'
             '<path class="mascot-body" d="M46.2571 147.343C27.895 138.682 41.2867 '
             '112.347 50.7053 99.6221C50.9911 99.2359 51.507 99.1217 51.9373 '
             '99.3352L80.5605 113.537C80.9854 113.747 81.207 114.218 81.0814 '
             '114.676C76.9661 129.653 64.6185 156.004 46.2571 147.343Z"/>'
             '<path class="mascot-body" d="M100.679 148.906C81.4109 155.303 72.9387 '
             '126.999 70.9791 111.289C70.9196 110.813 71.2143 110.374 71.6731 '
             '110.232L102.192 100.768C102.645 100.627 103.13 100.815 103.355 '
             '101.233C110.708 114.915 119.946 142.509 100.679 148.906Z"/>'
             '<path class="mascot-body" d="M141.907 137.171C123.521 145.777 108.249 '
             '121.319 104.342 106.038C104.223 105.572 104.464 105.101 104.903 '
             '104.906L134.106 91.9367C134.539 91.7442 135.043 91.8747 135.318 '
             '92.2606C144.344 104.897 160.294 128.565 141.907 137.171Z"/>'
             '<ellipse class="mascot-body" cx="80.382" cy="64.4336" rx="66.5695" '
             'ry="64.4336"/>',
        face="",
        eyes_neutral=('<g class="pupil"><ellipse cx="80.3823" cy="61.2988" '
                      'rx="29.1392" ry="32.6992" fill="var(--mascot-ink,#24211f)"/>'
                      '<ellipse cx="88.9814" cy="61.2988" rx="11.3301" '
                      'ry="17.668" fill="#fff"/></g>'),
        eyes_happy="<g>" + arc("M51 63Q80.4 33 110 63", 10) + "</g>",
        eyes_sleepy="<g>" + arc("M52 60Q80.4 80 109 60", 10) + "</g>",
    ),
    # White ghost, two solid black eyes. Source: Group 55.
    "ghost": dict(
        vb="0 0 154 156", w=154, h=156, body_default="#ffffff",
        label="Ghost",
        body='<path class="mascot-body" d="M26.2845 34.5792C15.7865 59.7741 10.7906 '
             '85.5773 7.87011 103.386C6.61577 111.035 2.13383 117.798 0.419744 '
             '125.357C0.155746 126.521 0 127.759 0 129.063C0 133.865 0.10914 '
             '146.962 14.7338 146.962C23.8521 146.962 30.69 142.41 34.4519 '
             '138.627C35.1766 137.898 36.8435 138.49 36.9412 139.513C37.6103 '
             '146.514 41.5608 155.839 54.024 155.693C67.3265 155.537 75.3787 '
             '146.475 78.5974 140.487C79.0084 139.722 80.1862 139.691 80.6168 '
             '140.445C84.2165 146.748 92.0373 156.167 101.609 155.147C109.06 '
             '154.203 115.2 151.038 119.686 139.14C119.943 138.459 120.82 138.246 '
             '121.365 138.727C133.745 149.663 148.704 149.751 153.106 '
             '137.569C155.845 129.99 150.402 122.372 148.108 114.646C144.203 '
             '101.491 149.735 84.6833 139.488 40.6224C126.377 -15.7529 44.5736 '
             '-9.31388 26.2845 34.5792Z"/>',
        face="",
        eyes_neutral=("<g>" + ell(62.8677, 64.0093, 9.56201, 19.8149) + "</g>"
                      + "<g>" + ell(99.9634, 64.0093, 9.56201, 19.8149) + "</g>"),
        eyes_happy="<g>" + arc("M53 67Q63 54 73 67", 6) + "</g>"
                   + "<g>" + arc("M90 67Q100 54 110 67", 6) + "</g>",
        eyes_sleepy="<g>" + arc("M54 63Q63 70 72 63", 6) + "</g>"
                    + "<g>" + arc("M91 63Q100 70 109 63", 6) + "</g>",
    ),
    # Tall white bunny, long ears, solid eyes, skull nose. Source: Group 57.
    "bunny": dict(
        vb="0 0 138 198", w=138, h=198, body_default="#ffffff",
        label="Bunny",
        body='<path class="mascot-body" d="M90.5 15.3888C104.5 -5.11099 126 -10.1107 '
             '128.5 31.8888C130.183 60.1598 121.598 84.5127 114.962 97.3839C129.1 '
             '108.188 138 123.899 138 141.389C138 173.974 107.108 197.889 69 '
             '197.889C30.8924 197.889 0 173.974 0 141.389C0 124.318 8.47873 '
             '108.939 22.0322 98.1661C15.781 84.7377 8.02535 62.1563 9 '
             '40.3888C10.2 13.5888 23.5002 5.22211 30 4.38877C37.6667 3.05544 '
             '53.6 8.58877 56 41.3888C57.4121 60.6869 57.7383 74.3541 57.6328 '
             '83.1847C61.3308 82.6605 65.1282 82.3888 69 82.3888C73.41 82.3888 '
             '77.7233 82.7429 81.9033 83.419C80.3879 63.5914 80.4965 30.0367 '
             '90.5 15.3888Z"/>',
        face='<path class="ink" d="M77.3329 151.389C79.358 151.389 80.9999 153.031 '
             '80.9999 155.056C80.9997 158.705 78.3334 161.73 74.8427 '
             '162.293C74.9923 162.819 75.1961 163.348 75.4667 163.84C76.1674 '
             '165.114 77.2907 166.162 79.4218 166.413C81.3414 166.639 82.714 '
             '168.378 82.4882 170.298C82.2622 172.217 80.5231 173.59 78.6034 '
             '173.364C75.226 172.967 72.7425 171.486 71.0058 169.568C69.269 '
             '171.486 66.7862 172.967 63.4091 173.364C61.4894 173.59 59.7503 '
             '172.217 59.5243 170.298C59.2985 168.378 60.6711 166.639 62.5907 '
             '166.413C64.7218 166.162 65.8451 165.114 66.5458 163.84C66.816 '
             '163.348 67.0183 162.82 67.1679 162.295C63.6719 161.737 61.0001 '
             '158.709 60.9999 155.056C60.9999 153.031 62.6418 151.389 64.6669 '
             '151.389H77.3329Z"/>',
        eyes_neutral=("<g>" + ell(34.5, 151.389, 8.5, 13) + "</g>"
                      + "<g>" + ell(106.5, 147.389, 8.5, 13) + "</g>"),
        eyes_happy="<g>" + arc("M24 153Q34.5 139 45 153", 8) + "</g>"
                   + "<g>" + arc("M96 149Q106.5 135 117 149", 8) + "</g>",
        eyes_sleepy="<g>" + arc("M24 150Q34.5 162 45 150", 8) + "</g>"
                    + "<g>" + arc("M96 146Q106.5 158 117 146", 8) + "</g>",
    ),
    # White horned blob, solid eyes, skull nose. Source: Group 58.
    "horned": dict(
        vb="0 0 162 153", w=162, h=153, body_default="#ffffff",
        label="Horned",
        body='<path class="mascot-body" d="M11.6265 3.55432C41.1957 -9.40861 50.3474 '
             '16.2942 51.4849 29.2643C64.2768 25.4194 76.099 24.4362 82.2183 '
             '24.4362C88.3604 24.4362 99.2156 25.4684 110.721 29.3912C113.46 '
             '16.8017 126.75 -7.89918 150.028 3.55627C173.583 15.1474 156.112 '
             '44.2353 143.78 52.5709C150.854 62.3133 155.535 75.3231 155.535 '
             '92.6461C155.535 140.503 102.037 152.467 75.2877 152.467C50.3622 '
             '152.589 0.511289 140.794 0.511289 92.6461C0.511302 74.6548 6.24888 '
             '61.3253 14.7603 51.4772C-0.0501909 43.6506 -7.89387 14.8254 '
             '11.6265 3.55432Z"/>',
        face='<path class="ink" d="M80.7606 99.001C82.7857 99.001 84.4276 100.643 '
             '84.4276 102.668C84.4275 106.317 81.7611 109.342 78.2704 '
             '109.905C78.42 110.431 78.6238 110.96 78.8944 111.452C79.5952 '
             '112.726 80.7184 113.775 82.8495 114.025C84.7691 114.251 86.1418 '
             '115.99 85.9159 117.91C85.6899 119.83 83.9508 121.202 82.0312 '
             '120.977C78.6537 120.579 76.1702 119.099 74.4335 117.181C72.6968 '
             '119.099 70.214 120.579 66.8368 120.977C64.9172 121.202 63.178 '
             '119.83 62.952 117.91C62.7262 115.99 64.0989 114.251 66.0185 '
             '114.025C68.1496 113.775 69.2728 112.726 69.9735 111.452C70.2437 '
             '110.961 70.446 110.432 70.5956 109.907C67.0996 109.349 64.4278 '
             '106.321 64.4276 102.668C64.4276 100.643 66.0696 99.001 68.0946 '
             '99.001H80.7606Z"/>',
        eyes_neutral=("<g>" + ell(37.9277, 99.001, 8.5, 13) + "</g>"
                      + "<g>" + ell(109.928, 95.001, 8.5, 13) + "</g>"),
        eyes_happy="<g>" + arc("M28 101Q38 87 48 101", 8) + "</g>"
                   + "<g>" + arc("M100 97Q110 83 120 97", 8) + "</g>",
        eyes_sleepy="<g>" + arc("M28 98Q38 110 48 98", 8) + "</g>"
                    + "<g>" + arc("M100 94Q110 106 120 94", 8) + "</g>",
    ),
    # White spiky sun blob, solid eyes, skull nose. Source: Group 59.
    "spiky": dict(
        vb="0 0 193 156", w=193, h=156, body_default="#ffffff",
        label="Spiky",
        body='<path class="mascot-body" d="M3.71779 119.612C3.71789 134.013 27.4581 '
             '137.352 39.3281 137.221C45.2473 143.399 65.0171 155.755 96.7433 '
             '155.755C128.469 155.755 147.834 143.399 153.55 137.221C165.34 '
             '135.467 188.921 129.49 188.921 119.612C188.921 109.733 177.488 '
             '110.024 171.771 111.404C178.631 107.824 192.351 98.377 192.351 '
             '89.2353C192.179 77.3497 177.845 81.9341 170.7 85.712C176.559 '
             '61.1129 184.762 10.3713 170.7 4.19758C153.122 -3.51961 131.256 '
             '25.8486 116.134 48.2737C98.6631 46.9528 94.1118 46.8051 78.109 '
             '48.2737C73.2641 31.9772 43.901 -3.40529 33.7707 0.265095C23.6405 '
             '3.93548 18.7956 15.3875 17.4742 42.1079C16.4172 63.4842 20.5574 '
             '80.0841 22.7596 85.712C15.272 82.482 0.238127 78.6646 0.00322275 '
             '89.2353C-0.231682 99.806 12.4336 108.419 18.7956 111.404C13.7696 '
             '110.866 3.71768 111.754 3.71779 119.612Z"/>',
        face='<path class="ink" d="M104.6 108.756C106.626 108.756 108.267 110.398 '
             '108.267 112.423C108.267 116.072 105.601 119.097 102.11 '
             '119.66C102.26 120.186 102.464 120.715 102.734 121.207C103.435 '
             '122.481 104.558 123.53 106.689 123.78C108.609 124.006 109.982 '
             '125.745 109.756 127.665C109.53 129.585 107.791 130.957 105.871 '
             '130.731C102.494 130.334 100.01 128.854 98.2733 126.936C96.5366 '
             '128.853 94.0538 130.334 90.6767 130.731C88.757 130.957 87.0179 '
             '129.585 86.7919 127.665C86.5661 125.745 87.9387 124.006 89.8583 '
             '123.78C91.9894 123.53 93.1126 122.481 93.8134 121.207C94.0836 '
             '120.716 94.2859 120.187 94.4354 119.662C90.9394 119.104 88.2676 '
             '116.076 88.2675 112.423C88.2675 110.398 89.9094 108.756 91.9345 '
             '108.756H104.6Z"/>',
        eyes_neutral=("<g>" + ell(61.7676, 108.756, 8.5, 13) + "</g>"
                      + "<g>" + ell(133.768, 104.756, 8.5, 13) + "</g>"),
        eyes_happy="<g>" + arc("M52 111Q62 97 72 111", 8) + "</g>"
                   + "<g>" + arc("M124 107Q134 93 144 107", 8) + "</g>",
        eyes_sleepy="<g>" + arc("M52 108Q62 120 72 108", 8) + "</g>"
                    + "<g>" + arc("M124 104Q134 116 144 104", 8) + "</g>",
    ),
}

os.makedirs(OUT, exist_ok=True)
made = []
for name, m in MASCOTS.items():
    variants = {"idle": m["eyes_neutral"], "happy": m["eyes_happy"],
                "sleepy": m["eyes_sleepy"], "spin": m["eyes_happy"]}
    for variant, eyes in variants.items():
        spin = variant == "spin"
        svg = build(name, m["w"], m["h"], m["vb"], m["body_default"],
                    m["label"], m["body"], m["face"], eyes, variant, spin,
                    blink=(variant in ("idle", "spin")),
                    slide=round(m["w"] * 0.45) if spin else None)
        path = os.path.join(OUT, name + "-" + variant + ".svg")
        with open(path, "w") as fh:
            fh.write(svg)
        made.append(path)
print("\n".join(made))
print("total:", len(made))
