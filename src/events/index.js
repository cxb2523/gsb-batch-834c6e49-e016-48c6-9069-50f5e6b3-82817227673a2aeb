import { Codec, UInt8Codec } from 'netcode/encoder';
import VideoCodec from '@events/VideoCodec';
import UserReadyCodec from '@events/UserReadyCodec';
import SeekCodec from '@events/SeekCodec';

export default [
    ['user:me', new UInt8Codec()],
    ['user:add', new UInt8Codec()],
    ['user:remove', new UInt8Codec()],
    ['user:ready', new UserReadyCodec()],
    ['control:play', new SeekCodec()],
    ['control:pause', new SeekCodec()],
    ['control:seek', new SeekCodec()],
    ['control:end', new Codec()],
    ['control:stop', new Codec()],
    ['video:file', new VideoCodec()],
    ['video:url', new VideoCodec()],
    ['video:youtube', new VideoCodec()],
];
