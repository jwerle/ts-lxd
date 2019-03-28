import debugOutput from "debug";
import { parse as parseUrl } from "url";
import { Agent } from "https";
import createWebSocketStream, { WebSocketDuplex } from "websocket-stream";

import { Container } from "./Container";
import { OperationError } from "./OperationError";
import { Process } from "./Process";
import { Profile } from "./Profile";

import { IContainersMetadata, IOperationMetadata, IExecOperationMetadata, IContainerMetadata, IContainerStateMetadata, IProfilesMetadata, IProfileMetadata, IAuthorizeCertificateRequest, ITrustedInfoMetadata } from "./model";

import { request } from "./utilities/request";

const debug = debugOutput("lxd:Client");

export interface IRequestOptions<T> {
  path: string;
  body?: T;
  waitForOperationCompletion?: boolean;
}

// client
export class Client {
  /**
   * The request.js path for the API.
   */
  private _path: string = "";

  /**
   * The web socket path for the API.
   */
  private _wsPath: string = "";

  private _info?: ITrustedInfoMetadata;

  private _local: boolean = false;

  private _agent?: Agent;

  /**
   * Gets if the client is connected to a local unix socket.
   */
  get local(): boolean {
    return this._local;
  }

  /**
   * Creates a new LXD client.
   * @param host?
   * @param authenticate?
   */
  constructor(host?: string, authenticate?: { cert: string, key: string, ca: string, password: string }) {
    let protocol: string;
    let hostname: string;
    let port: number;

    if (host) {
      this._local = false;

      const hostUrl = parseUrl(host);
      protocol = hostUrl.protocol as string;
      hostname = hostUrl.hostname as string;
      port = parseInt(hostUrl.port as string, 10);

      this._wsPath = "ws://" + hostname;
      this._wsPath += port ? ":" + port + "/" : "/";

      this._path = protocol + "//" + hostname;
      this._path += port ? ":" + port + "/" : "/";
    } else {
      this._local = true;
      this._path = "http://unix:/var/lib/lxd/unix.socket:/";
      this._wsPath = "ws+unix:///var/lib/lxd/unix.socket:/";
    }

    if (authenticate && authenticate.cert && authenticate.key) {
      this._agent = new Agent({
        cert: authenticate.cert,
        key: authenticate.key,
        ca: authenticate.ca,
      });
    }

    (async () => {
      this._info = await this.getInfo();

      if (authenticate && authenticate.cert) {
        await this.authorizeCertificate(authenticate.password);
      }
      // debug info
      debug("LXC " + this._info.environment.server_version + " on " +
        this._info.environment.kernel + " using " +
        this._info.environment.storage + " v" +
        this._info.environment.storage_version);
    })();
  }

  /**
   * Gets all containers.
   */
  public async getAllContainers(): Promise<Container[]> {
    const client = this;
    const containerNames: IContainersMetadata = await this.request<never, IContainersMetadata>({ path: "GET /containers" }) as IContainersMetadata;

    return Promise.all(containerNames.map((containerName) => {
      return client.getContainer(containerName.split("/").slice(-1)[0]);
    }));
  }

  /**
   * Gets a container with the specified name.
   * @param name
   */
  public async getContainer(name: string): Promise<Container> {
    const metadata = await this.request<never, IContainerMetadata>({ path: "GET /containers/" + name }) as IContainerMetadata;
    const state = await this.request<never, IContainerStateMetadata>({ path: "GET /containers/" + name + "/state" }) as IContainerStateMetadata;

    return new Container(this, metadata, state);
  }

  public async getProcess(operation: IOperationMetadata<IExecOperationMetadata>, interactive: boolean) {
    // socket connect queue
    const streams: WebSocketDuplex[] = [];

    const controlFd = interactive === true ? 1 : 3;
    const streamCount = interactive === true ? 2 : 4;

    try {
      for (let i = 0; i < streamCount; i++) {
        const fds = operation.metadata.fds ? operation.metadata.fds : operation.metadata.output;

        if (!fds) {
          throw new Error("No streams to connect to!");
        }

        if (interactive) {
          const wsSecret = fds[(i === controlFd) ? "control" : i.toString()];
          const baseWsUrl = `${this._wsPath}1.0/operations/${operation.id}/websocket${wsSecret ? `?secret=${wsSecret}` : ""}`;

          streams.push(createWebSocketStream(baseWsUrl, {
            agent: this._agent,
          }));
        }
      }

      return new Process(streams);
    } catch (err) {
      for (const stream of streams) {
        stream.end();
      }
      throw err;
    }
  }

  /**
   * Gets all profiles.
   */
  public async getAllProfiles(): Promise<Profile[]> {
    const client = this;
    const profiles = await this.request<never, IProfilesMetadata>({ path: "GET /profiles" }) as IProfilesMetadata;
    return Promise.all(profiles.map((profileName) => {
      return client.profile(profileName.split("/").slice(-1)[0]);
    }));
  }

  /**
   * Gets a profile by the specified name.
   * @param name
   */
  public async profile(name: string): Promise<Profile> {
    const metadata = await this.request<never, IProfileMetadata>({ path: "GET /profiles/" + name }) as IProfileMetadata;
    return new Profile(this, metadata);
  }

  /**
   * Authorizes certificate assigned to requests.
   * @param password
   */
  public async authorizeCertificate(password: string): Promise<void> {
    await this.request<IAuthorizeCertificateRequest, never>({ path: "POST /certificates", body: { type: "client", password } });
  }

  /**
   * Creates a new container and starts it.
   * @param name
   * @param image
   * @param config
   * @param profile
   */
  public async launch(name: string, image: string, config: any, profile?: string): Promise<Container> {
    const container: Container = await this.create(name, image, config, profile);
    await container.start();
    return container;
  }

  /**
   * Creates a new container.
   * @param name
   * @param image
   * @param config
   * @param profile
   */
  public async create(name: string, image: string, config?: any, profile?: string): Promise<Container> {
    if (config === undefined) {
      config = {};
    }

    if (profile === undefined) {
      profile = "default";
    }

    // check name length
    if (name.length === 0) {
      throw new OperationError("Container name too small", "Failed", 400);
    } else if (name.length > 64) {
        throw new OperationError("Container name too long", "Failed", 400);
    }

    await this.request({
      path: "POST /containers",
      body: {
        name,
        architecture: "x86_64",
        profiles: [profile],
        ephemeral: false,
        config,
        source: {
          type: "image",
          alias: image,
        },
      },
    });

    return await this.getContainer(name);
  }

  /**
   * Gets information about the server.
   */
  public async getInfo(): Promise<ITrustedInfoMetadata> {
    const info: ITrustedInfoMetadata = await this.request({ path: "GET /" }) as ITrustedInfoMetadata;
    return info;
  }

  public async request<ReqT, ResT>(opts: IRequestOptions<ReqT>): Promise<ResT | IOperationMetadata<ResT>> {
    return request<ReqT, ResT>({
      ...opts,
      baseRequestUrl: this._path,
      agent: this._agent,
    });
  }
}

export default Client;