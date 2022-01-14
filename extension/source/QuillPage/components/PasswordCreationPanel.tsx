import * as React from 'react';
import { browser } from 'webextension-polyfill-ts';
import Button from '../../components/Button';
import PasswordCreationForm from './PasswordCreationForm';

const PasswordCreationPanel: React.FunctionComponent<{
  onComplete: () => void;
}> = ({ onComplete }) => (
  <>
    <div className="instructions-text">
      <h3>Let&apos;s start by setting a password.</h3>
      <p>
        Occasionally we will ask you for this to prevent unwanted access of your
        wallets.
      </p>
    </div>
    <PasswordCreationForm onPasswordUpdate={() => {}} />
    <div>
      <div style={{ display: 'inline-block' }}>
        <Button
          onPress={onComplete}
          highlight={true}
          icon={{
            src: browser.runtime.getURL('assets/arrow-small.svg'),
            px: 19,
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  </>
);

export default PasswordCreationPanel;
