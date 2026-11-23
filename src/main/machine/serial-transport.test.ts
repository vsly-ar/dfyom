// `SerialTransport` over serialport's mock binding (no hardware), and `nodeSerialPorts` loading the
// real native binding. Spec: docs/modes/run-machine.md#testing
import { afterEach, describe, expect, it } from 'vitest'
import { SerialPortMock } from 'serialport'
import { expectErrCode, expectOk } from '../../shared/testing/result'
import { nodeSerialPorts, portInfo, serialPortsOf, type PortStream } from './serial-transport'

const MockBinding = SerialPortMock.binding

const PATH = '/dev/cu.usbmodemTEST'

const mockPorts = serialPortsOf(async () => ({
  list: () => SerialPortMock.list(),
  create: (path, baudRate) =>
    new SerialPortMock({ path, baudRate, autoOpen: false }) as unknown as PortStream,
}))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterEach(() => MockBinding.reset())

describe('SerialTransport (mock binding)', () => {
  it('lists ports with USB info', async () => {
    MockBinding.createPort(PATH, { echo: false, record: true, vendorId: '2341', productId: '0043' })
    MockBinding.createPort('/dev/ttyS0', { echo: false, record: false })
    const ports = expectOk(await mockPorts.list())
    const usb = ports.find((p) => p.path === PATH)
    expect(usb).toMatchObject({ vendorId: '2341', productId: '0043', usb: true })
  })

  it('writes bytes, delivers received ones, closes without a lost-connection report', async () => {
    MockBinding.createPort(PATH, { echo: false, record: true })
    const t = expectOk(await mockPorts.open(PATH, 115_200))
    const got: number[] = []
    t.onData((b) => got.push(...b))
    const lost: string[] = []
    t.onClose?.((r) => lost.push(r))
    expectOk(await t.write(new TextEncoder().encode('$$\n')))
    const port = (t as unknown as { port: SerialPortMock }).port
    expect(new TextDecoder().decode(port.port?.recording)).toBe('$$\n')
    port.port?.emitData(Buffer.from('ok\r\n'))
    await sleep(20)
    expect(new TextDecoder().decode(new Uint8Array(got))).toBe('ok\r\n')
    expectOk(await t.close())
    expect(lost).toEqual([])
    expectErrCode(await t.write(new Uint8Array([0x3f])), 'machine.connection')
  })

  it('a port that goes away reports close once', async () => {
    MockBinding.createPort(PATH, { echo: false, record: false })
    const t = expectOk(await mockPorts.open(PATH, 115_200))
    const lost: string[] = []
    t.onClose?.((r) => lost.push(r))
    const port = (t as unknown as { port: SerialPortMock }).port
    port.emit('close', Object.assign(new Error('device disconnected'), { disconnected: true }))
    port.emit('error', new Error('again'))
    expect(lost).toEqual(['device disconnected'])
  })

  it('opening a missing port fails with machine.connection and the path', async () => {
    const r = await mockPorts.open('/dev/missing', 115_200)
    expectErrCode(r, 'machine.connection')
    expect(r.unwrapErr().message).toContain('/dev/missing')
  })

  it('a module that does not load fails as machine.connection', async () => {
    const broken = serialPortsOf(() => Promise.reject(new Error('no binding')))
    expectErrCode(await broken.list(), 'machine.connection')
    expectErrCode(await broken.open(PATH, 115_200), 'machine.connection')
  })

  it('maps port info', () => {
    expect(portInfo({ path: '/dev/ttyS0', manufacturer: '' })).toEqual({
      path: '/dev/ttyS0',
      usb: false,
    })
  })
})

describe('nodeSerialPorts (native binding)', () => {
  it('loads serialport and lists the ports of this machine', async () => {
    const ports = expectOk(await nodeSerialPorts.list())
    expect(Array.isArray(ports)).toBe(true)
  })
})
