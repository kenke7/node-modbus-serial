"use strict";
const events = require("events");
const EventEmitter = events.EventEmitter || events;
const net = require("net");
const modbusSerialDebug = require("debug")("modbus-serial");

const crc16 = require("../utils/crc16");

/* TODO: const should be set once, maybe */
const EXCEPTION_LENGTH = 3;
const MIN_DATA_LENGTH = 8;
const MIN_MBAP_LENGTH = 0;
const MAX_TRANSACTIONS = 64; // maximum transaction to wait for
const MAX_BUFFER_LENGTH = 9;
const CRC_LENGTH = 2;
const TXN_ENABLED = false;

const MODBUS_PORT = 502;

class TcpRTUBufferedPort extends EventEmitter {
    /**
     * Simulate a modbus-RTU port using TCP connection
     * @module TcpRTUBufferedPort
     *
     * @param {string} ip - ip address
     * @param {object} options - all options as JSON object
     *   options.port: Nonstandard Modbus port (default is 502).
     *   options.localAddress: Local IP address to bind to, default is any.
     *   options.family: 4 = IPv4-only, 6 = IPv6-only, 0 = either (default).
     * @constructor
     */
    constructor(ip, options) {
        super();

        const modbus = this;
        modbus.openFlag = false;
        modbus.callback = null;
        modbus._transactionIdWrite = 1;
        this._externalSocket = null;

        // options
        if(typeof ip === "object") {
            options = ip;
        }
        if (typeof options === "undefined") options = {};
        modbus.connectOptions = {
            host: ip || options.ip,
            port: options.port || MODBUS_PORT,
            localAddress: options.localAddress,
            family: options.family || 0
        };

        if(options.socket) {
            if(options.socket instanceof net.Socket) {
                this._externalSocket = options.socket;
                this.openFlag = this._externalSocket.readyState === "opening" || this._externalSocket.readyState === "open";
            } else {
                throw new Error("invalid socket provided");
            }
        }

        // internal buffer
        modbus._buffer = Buffer.alloc(0);

        // handle callback - call a callback function only once, for the first event
        // it will triger
        const handleCallback = function(had_error) {
            if (modbus.callback) {
                modbus.callback(had_error);
                modbus.callback = null;
            }
        };

        // create a socket
        modbus._client = this._externalSocket || new net.Socket();
        if (options.timeout) this._client.setTimeout(options.timeout);

        // register the port data event
        modbus._client.on("data", function onData(data) {
            // add data to buffer
            modbus._buffer = Buffer.concat([modbus._buffer, data]);

            modbusSerialDebug({
                action: "receive tcp rtu buffered port",
                data: data,
                buffer: modbus._buffer
            });

            // check if buffer include a complete modbus answer
            let bufferLength = modbus._buffer.length;

            // check data length
            if (bufferLength < Math.max(MIN_MBAP_LENGTH, MIN_MBAP_LENGTH + EXCEPTION_LENGTH, MIN_DATA_LENGTH)) return;

            // check buffer size for MAX_BUFFER_SIZE
            if (bufferLength > MAX_BUFFER_LENGTH) {
                modbus._buffer = modbus._buffer.slice(-MAX_BUFFER_LENGTH);
                bufferLength = MAX_BUFFER_LENGTH;
            }

            // loop and check length-sized buffer chunks
            const maxOffset = bufferLength - MIN_MBAP_LENGTH;
            for (let i = 0; i <= maxOffset; i++) {
                const protocolID = TXN_ENABLED ? modbus._buffer.readUInt16BE(i + 2) : 0
                const msgLength = TXN_ENABLED ? modbus._buffer.readUInt16BE(i + 4) : bufferLength - CRC_LENGTH;
                const cmd = TXN_ENABLED ? modbus._buffer[i + 7] : modbus._buffer.readUInt8(i + 1);
                modbus._transactionIdRead = TXN_ENABLED ? modbus._buffer.readUInt16BE(i += 2) : null;

                modbusSerialDebug({
                    protocolID: protocolID,
                    msgLength: msgLength,
                    bufferLength: bufferLength,
                    cmd: cmd
                });

                if (
                    protocolID === 0 &&
                    cmd !== 0 &&
                    msgLength >= EXCEPTION_LENGTH &&
                    i + MIN_MBAP_LENGTH + msgLength <= bufferLength
                ) {
                    // remove crc and emit
                    let msgData = modbus._buffer.slice(i + MIN_MBAP_LENGTH, i + MIN_MBAP_LENGTH + msgLength);
                    modbus._buffer = modbus._buffer.slice(bufferLength);
                    modbus._emitData(msgData);
                    return;
                }
            }
        });

        this._client.on("connect", function() {
            modbus.openFlag = true;
            handleCallback();
        });

        this._client.on("close", function(had_error) {
            modbus.openFlag = false;
            handleCallback(had_error);
            modbus.emit("close");
        });

        this._client.on("error", function(had_error) {
            modbus.openFlag = false;
            handleCallback(had_error);
        });

        this._client.on("timeout", function() {
            // modbus.openFlag is left in its current state as it reflects two types of timeouts,
            // i.e. 'false' for "TCP connection timeout" and 'true' for "Modbus response timeout"
            // (this allows to continue Modbus request re-tries without reconnecting TCP).
            modbusSerialDebug("TcpRTUBufferedPort port: TimedOut");
            handleCallback(new Error("TcpRTUBufferedPort Connection Timed Out"));
        });
    }

    /**
     * Check if port is open.
     *
     * @returns {boolean}
     */
    get isOpen() {
        return this.openFlag;
    }

    /**
     * Emit the received response.
     *
     * @param {buffer} data the data to emit
     * @private
     */
    _emitData(data) {
        const modbus = this;

        if (data.length > 0) {
            const buffer = Buffer.alloc(data.length + CRC_LENGTH);
            data.copy(buffer, 0);

            // add crc
            const crc = crc16(buffer.slice(0, -CRC_LENGTH));
            buffer.writeUInt16LE(crc, buffer.length - CRC_LENGTH);

            modbusSerialDebug({
                action: "parsed tcp buffered port",
                buffer: buffer,
                transactionId: modbus._transactionIdRead
            });

            modbus.emit("data", buffer);
        } else {
            modbusSerialDebug({ action: "emit empty data" });
        }
    }

    /**
     * Simulate successful port open.
     *
     * @param callback
     */
    open(callback) {
        if(this._externalSocket === null) {
            this.callback = callback;
            this._client.connect(this.connectOptions);
        } else if(this.openFlag) {
            modbusSerialDebug("TcpRTUBuffered port: external socket is opened");
            callback(); // go ahead to setup existing socket
        } else {
            callback(new Error("TcpRTUBuffered port: external socket is not opened"));
        }
    }

    /**
     * Simulate successful close port.
     *
     * @param callback
     */
    close(callback) {
        this.callback = callback;
        this._client.end(callback);

        this.removeAllListeners();
    }

    /**
     * Simulate successful destroy port.
     *
     * @param callback
     */
    destroy(callback) {
        this.callback = callback;
        if (!this._client.destroyed) {
            this._client.destroy();
        }
    }

    /**
     * Send data to a modbus slave via telnet server.
     *
     * @param {Buffer} data
     */
    write(data) {
        if (data.length < MIN_DATA_LENGTH) {
            modbusSerialDebug(
                "expected length of data is to small - minimum is " +
                    MIN_DATA_LENGTH
            );
            return;
        }

        const buffer = TXN_ENABLED ? Buffer.alloc(data.length + MIN_MBAP_LENGTH - CRC_LENGTH) : Buffer.alloc(data.length);
        if (TXN_ENABLED) {
            buffer.writeUInt16BE(this._transactionIdWrite, 0);
            buffer.writeUInt16BE(0, 2);
            buffer.writeUInt16BE(data.length - CRC_LENGTH, 4);
            data.copy(buffer, MIN_MBAP_LENGTH);
        } else {
            data.copy(buffer, 0);
        }

        modbusSerialDebug({
            action: "send tcp rtu buffered port",
            data: data,
            buffer: buffer,
            transactionsId: this._transactionIdWrite
        });

        // send buffer to slave
        this._client.write(buffer);

        if (TXN_ENABLED) {
            // get next transaction id
            this._transactionIdWrite = (this._transactionIdWrite + 1) % MAX_TRANSACTIONS;
        }
    }
}

/**
 * TCP RTU bufferd port for Modbus.
 *
 * @type {TcpRTUBufferedPort}
 */
module.exports = TcpRTUBufferedPort;
