/** Isolated Python stdlib + system X11 libraries; deliberately no shell/xdotool fallback. */
export const LINUX_HELPER_SOURCE = String.raw`
import base64, ctypes as C, json, os, re, struct, sys, zlib

def run(request):
    if os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland':
        raise RuntimeError('Wayland is unsupported: portal-selected PipeWire streams and target-bound input sessions are not implemented; XWayland fallback is disabled')
    if not re.fullmatch(r'(?:unix)?:[0-9]+(?:\.[0-9]+)?', os.environ.get('DISPLAY', '')):
        raise RuntimeError('A local X11 DISPLAY is required; remote displays cannot be bound to local process identities')
    x = C.CDLL('libX11.so.6')
    res = C.CDLL('libXres.so.1')
    U = C.c_ulong; I = C.c_int; P = C.c_void_p
    def bind(lib, name, result, *args):
        f = getattr(lib, name); f.restype = result; f.argtypes = list(args); return f
    bind(x, 'XOpenDisplay', P, C.c_char_p)
    bind(x, 'XDefaultRootWindow', U, P)
    bind(x, 'XCloseDisplay', I, P)
    bind(x, 'XInternAtom', U, P, C.c_char_p, I)
    bind(x, 'XGetWindowProperty', I, P, U, U, C.c_long, C.c_long, I, U, C.POINTER(U), C.POINTER(I), C.POINTER(U), C.POINTER(U), C.POINTER(P))
    bind(x, 'XFree', I, P)
    bind(x, 'XSync', I, P, I)
    bind(x, 'XRaiseWindow', I, P, U)
    bind(x, 'XSetInputFocus', I, P, U, I, U)
    bind(x, 'XGetInputFocus', I, P, C.POINTER(U), C.POINTER(I))
    errors = []
    callback_type = C.CFUNCTYPE(I, P, P)
    callback = callback_type(lambda display, error: errors.append(True) or 0)
    bind(x, 'XSetErrorHandler', P, callback_type)(callback)
    display = x.XOpenDisplay(None)
    if not display: raise RuntimeError('Cannot connect to local X11 display')
    def sync():
        x.XSync(display, 0)
        if errors: errors.clear(); raise RuntimeError('X11 rejected operation; target may have disappeared')
    class Spec(C.Structure): _fields_ = [('client', U), ('mask', C.c_uint)]
    class Value(C.Structure): _fields_ = [('spec', Spec), ('length', C.c_long), ('value', P)]
    bind(res, 'XResQueryVersion', I, P, C.POINTER(I), C.POINTER(I))
    bind(res, 'XResQueryClientIds', I, P, C.c_long, C.POINTER(Spec), C.POINTER(C.c_long), C.POINTER(C.POINTER(Value)))
    bind(res, 'XResGetClientPid', I, C.POINTER(Value))
    bind(res, 'XResClientIdsDestroy', None, C.c_long, C.POINTER(Value))
    major = I(); minor = I()
    if not res.XResQueryVersion(display, C.byref(major), C.byref(minor)) or (major.value, minor.value) < (1, 2):
        raise RuntimeError('XRes 1.2 is required for server-resolved client PID; untrusted _NET_WM_PID is never used')
    def prop(window, name):
        actual = U(); fmt = I(); count = U(); remaining = U(); data = P()
        atom = x.XInternAtom(display, name.encode(), 1)
        if not atom: return None
        result = x.XGetWindowProperty(display, window, atom, 0, 4096, 0, 0, C.byref(actual), C.byref(fmt), C.byref(count), C.byref(remaining), C.byref(data))
        try:
            sync()
            if result or remaining.value or not data: return None
            if fmt.value == 32: return list(C.cast(data, C.POINTER(U))[:count.value])
            if fmt.value == 8: return C.string_at(data, count.value).decode('utf-8', errors='replace')
            return None
        finally:
            if data: x.XFree(data)
    root = x.XDefaultRootWindow(display)
    def target(window):
        spec = Spec(window, 2); count = C.c_long(); values = C.POINTER(Value)()
        res.XResQueryClientIds(display, 1, C.byref(spec), C.byref(count), C.byref(values))
        try:
            sync()
            owners = {res.XResGetClientPid(C.byref(values[i])) for i in range(count.value)}
            owners.discard(-1)
            if len(owners) != 1: raise RuntimeError('Window has no unique server-resolved local PID')
            pid = owners.pop()
        finally:
            if values: res.XResClientIdsDestroy(count, values)
        if pid <= 0 or os.stat('/proc/' + str(pid)).st_uid != os.getuid(): raise RuntimeError('Target must belong to current user')
        executable = os.readlink('/proc/' + str(pid) + '/exe')
        if not executable.startswith('/') or executable.endswith(' (deleted)'): raise RuntimeError('Target executable is unavailable')
        with open('/proc/' + str(pid) + '/stat') as file: stat = file.read()
        start = stat[stat.rfind(')')+2:].split()[19]
        title = prop(window, '_NET_WM_NAME') or prop(window, 'WM_NAME') or ''
        return dict(appId='linux:' + executable, windowId=str(window) + ':' + start, pid=pid, title=title if isinstance(title, str) else '')
    def resolve(wanted):
        if not re.fullmatch(r'[1-9][0-9]*:[0-9]+', wanted['windowId']): raise RuntimeError('Invalid target identifier')
        window = int(wanted['windowId'].split(':')[0])
        if window not in (prop(root, '_NET_CLIENT_LIST') or []): raise RuntimeError('Target is not a managed application window')
        current = target(window)
        if any(current[key] != wanted[key] for key in ('appId', 'windowId', 'pid')): raise RuntimeError('Target identity changed')
        return window
    composite = None
    xtest = None
    try:
        xtest = C.CDLL('libXtst.so.6')
        bind(xtest, 'XTestFakeMotionEvent', I, P, I, I, I)
        bind(xtest, 'XTestFakeButtonEvent', I, P, C.c_uint, I, I)
        bind(xtest, 'XTestFakeKeyEvent', I, P, C.c_uint, I, I)
        bind(xtest, 'XTestGrabControl', None, P, I)
    except (OSError, AttributeError): xtest = None
    bind(x, 'XTranslateCoordinates', I, P, U, U, I, I, C.POINTER(I), C.POINTER(I), C.POINTER(U))
    bind(x, 'XKeysymToKeycode', C.c_ubyte, P, U)
    bind(x, 'XStringToKeysym', U, C.c_char_p)
    bind(x, 'XGetGeometry', I, P, U, C.POINTER(U), C.POINTER(I), C.POINTER(I), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint))
    try:
        composite = C.CDLL('libXcomposite.so.1')
        bind(composite, 'XCompositeQueryVersion', I, P, C.POINTER(I), C.POINTER(I))
        bind(composite, 'XCompositeNameWindowPixmap', U, P, U)
        a = I(); b = I()
        if not composite.XCompositeQueryVersion(display, C.byref(a), C.byref(b)) or (a.value, b.value) < (0, 2): composite = None
    except (OSError, AttributeError): composite = None
    try:
        kind = request['kind']
        if kind == 'status':
            limitations = ['Requires Python 3, local X11, libX11, libXres / XRes 1.2 and same-user /proc executable access.', 'Capture requires an existing compositor-redirected window and libXcomposite; no root-window or desktop capture fallback.', 'AT-SPI element IDs are not available on this adapter; validated window-relative coordinates are used for X11 input.', 'X11/native window APIs are not a security sandbox; other desktop clients and embedded content are outside these identity checks.']
            if not composite: limitations.append('XComposite 0.2+ unavailable; observation disabled.')
            if not xtest: limitations.append('XTest unavailable; pointer, keyboard, text and scroll actions disabled.')
            actions = ['discover', 'focus'] + (['observe'] if composite else [])
            if xtest: actions += ['click', 'doubleClick', 'move', 'drag', 'type', 'key', 'scroll']
            return dict(platform='linux', available=True, capabilities=['discover', 'manageWindows', 'interact'] if xtest else ['discover', 'manageWindows'], actions=actions, limitations=limitations)
        if kind == 'discover':
            targets = []
            for window in (prop(root, '_NET_CLIENT_LIST') or [])[:1024]:
                try: targets.append(target(window))
                except (OSError, RuntimeError, IndexError): pass
            return dict(targets=targets)
        window = resolve(request['target'])
        if kind == 'focus':
            x.XRaiseWindow(display, window); x.XSetInputFocus(display, window, 2, 0); sync()
            actual = U(); revert = I(); x.XGetInputFocus(display, C.byref(actual), C.byref(revert)); sync()
            if actual.value != window: raise RuntimeError('X11 refused window focus')
            return dict(text='Focused target X11 window.')
        if kind != 'observe':
            if not xtest: raise RuntimeError('XTest is unavailable; target-bound input is unsupported')
            if request.get('elementId'): raise RuntimeError('X11 semantic element IDs are unavailable; use fresh coordinates')
            # Input is only sent after the target has been raised and verified as focused.
            x.XRaiseWindow(display, window); x.XSetInputFocus(display, window, 2, 0); sync()
            actual = U(); revert = I(); x.XGetInputFocus(display, C.byref(actual), C.byref(revert)); sync()
            if actual.value != window: raise RuntimeError('User or another client owns focus; input refused')
            root_return = U(); wx = I(); wy = I(); width = C.c_uint(); height = C.c_uint(); border = C.c_uint(); depth = C.c_uint()
            if not x.XGetGeometry(display, window, C.byref(root_return), C.byref(wx), C.byref(wy), C.byref(width), C.byref(height), C.byref(border), C.byref(depth)): raise RuntimeError('Cannot read target geometry')
            root_x = I(); root_y = I(); child = U()
            def move_to(px, py):
                if not x.XTranslateCoordinates(display, window, root, int(px), int(py), C.byref(root_x), C.byref(root_y), C.byref(child)): raise RuntimeError('Cannot translate target coordinates')
                xtest.XTestFakeMotionEvent(display, -1, root_x.value, root_y.value, 0); x.XSync(display, 0); sync()
            def button(button_number, pressed): xtest.XTestFakeButtonEvent(display, button_number, pressed, 0); x.XSync(display, 0); sync()
            def keysym(name):
                raw = name.encode('ascii', errors='ignore'); symbol = x.XStringToKeysym(raw)
                if not symbol and len(name) == 1: symbol = x.XStringToKeysym(name.lower().encode())
                code = x.XKeysymToKeycode(display, symbol)
                if not code: raise RuntimeError('Unsupported X11 key')
                return code
            if kind in ('click', 'doubleClick', 'move'):
                px = request.get('x'); py = request.get('y')
                if not isinstance(px, int) or not isinstance(py, int): raise RuntimeError('Coordinates are required on X11')
                move_to(px, py)
                if kind == 'move': return dict(text='Moved pointer in authorized X11 target.')
                number = {'left': 1, 'middle': 2, 'right': 3}.get(request.get('button', 'left'), 1)
                button(number, 1); button(number, 0)
                if kind == 'doubleClick': button(number, 1); button(number, 0)
                return dict(text='Clicked authorized X11 target coordinates.')
            if kind == 'drag':
                path = request.get('path') or []
                if not isinstance(path, list) or len(path) < 2: raise RuntimeError('Drag path requires two points')
                move_to(path[0]['x'], path[0]['y']); button(1, 1)
                for point in path[1:]: move_to(point['x'], point['y'])
                button(1, 0); return dict(text='Dragged through authorized X11 target.')
            if kind == 'scroll':
                move_to(int(width.value / 2), int(height.value / 2)); count = int(request.get('delta', 0)); number = 4 if count < 0 else 5
                for _ in range(min(abs(count), 100)): button(number, 1); button(number, 0)
                return dict(text='Scrolled authorized X11 target.')
            if kind == 'key':
                parts = str(request.get('key', '')).split('+'); modifiers = {'mod': 'Super_L', 'meta': 'Super_L', 'ctrl': 'Control_L', 'control': 'Control_L', 'alt': 'Alt_L', 'option': 'Alt_L', 'shift': 'Shift_L'}
                held = []
                for modifier in parts[:-1]:
                    code = keysym(modifiers.get(modifier.lower(), modifier)); xtest.XTestFakeKeyEvent(display, code, 1, 0); held.append(code)
                code = keysym(parts[-1]); xtest.XTestFakeKeyEvent(display, code, 1, 0); xtest.XTestFakeKeyEvent(display, code, 0, 0)
                for modifier in reversed(held): xtest.XTestFakeKeyEvent(display, modifier, 0, 0)
                x.XSync(display, 0); sync(); return dict(text='Sent key chord to authorized X11 target.')
            if kind == 'type':
                text = request.get('text', '')
                if not isinstance(text, str) or len(text) > 16384: raise RuntimeError('Invalid text')
                for character in text:
                    code = keysym(character); xtest.XTestFakeKeyEvent(display, code, 1, 0); xtest.XTestFakeKeyEvent(display, code, 0, 0)
                x.XSync(display, 0); sync(); return dict(text='Typed text into authorized X11 target.')
            raise RuntimeError('Unsupported X11 action')
        if not composite: raise RuntimeError('Window capture requires XComposite 0.2+')
        bind(x, 'XGetGeometry', I, P, U, C.POINTER(U), C.POINTER(I), C.POINTER(I), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint))
        bind(x, 'XGetImage', P, P, U, I, I, C.c_uint, C.c_uint, U, I)
        bind(x, 'XGetPixel', U, P, I, I)
        bind(x, 'XDestroyImage', I, P)
        bind(x, 'XFreePixmap', I, P, U)
        pixmap = composite.XCompositeNameWindowPixmap(display, window); sync()
        if not pixmap: raise RuntimeError('Window is not compositor-redirected; no capture fallback')
        image = None
        try:
            root_return = U(); left = I(); top = I(); width = C.c_uint(); height = C.c_uint(); border = C.c_uint(); depth = C.c_uint()
            if not x.XGetGeometry(display, pixmap, C.byref(root_return), C.byref(left), C.byref(top), C.byref(width), C.byref(height), C.byref(border), C.byref(depth)): raise RuntimeError('Cannot read window pixmap geometry')
            sync(); w = width.value; h = height.value
            if not w or not h or w > 8192 or h > 8192 or w*h > 4194304: raise RuntimeError('Window exceeds X11 capture size limit')
            image = x.XGetImage(display, pixmap, 0, 0, w, h, U(-1), 2); sync()
            if not image: raise RuntimeError('Window pixmap capture failed')
            class Image(C.Structure):
                _fields_ = [('width', I), ('height', I), ('xoffset', I), ('format', I), ('data', P), ('byte_order', I), ('bitmap_unit', I), ('bitmap_bit_order', I), ('bitmap_pad', I), ('depth', I), ('bytes_per_line', I), ('bits_per_pixel', I), ('red_mask', U), ('green_mask', U), ('blue_mask', U)]
            metadata = C.cast(image, C.POINTER(Image)).contents
            if (metadata.red_mask, metadata.green_mask, metadata.blue_mask) != (0xff0000, 0xff00, 0xff): raise RuntimeError('Unsupported X11 pixel format')
            raw = bytearray()
            for y in range(h):
                raw.append(0)
                for column in range(w):
                    pixel = x.XGetPixel(image, column, y)
                    raw.extend(((pixel >> 16) & 255, (pixel >> 8) & 255, pixel & 255))
            resolve(request['target'])
            def chunk(name, data): return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name + data) & 0xffffffff)
            png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
            return dict(imageBase64=base64.b64encode(png).decode('ascii'), text='Window-only XComposite pixmap; application content is untrusted.')
        finally:
            if image: x.XDestroyImage(image)
            x.XFreePixmap(display, pixmap)
    finally: x.XCloseDisplay(display)

try:
    result = run(json.load(sys.stdin))
except Exception as error:
    result = dict(error=str(error))
print(json.dumps(result, separators=(',', ':')))
`;
