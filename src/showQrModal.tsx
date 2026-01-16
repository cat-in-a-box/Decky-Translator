import { showModal, ModalRoot } from '@decky/ui';
import { QRCodeSVG } from 'qrcode.react';

const showQrModal = (url: string) => {
    showModal(
        <ModalRoot>
            <QRCodeSVG
                style={{ margin: '0 auto 1.5em auto', display: 'block' }}
                value={url}
                includeMargin
                size={256}
            />
            <span style={{ textAlign: 'center', wordBreak: 'break-word', display: 'block' }}>{url}</span>
        </ModalRoot>,
        window
    );
};

export default showQrModal;
